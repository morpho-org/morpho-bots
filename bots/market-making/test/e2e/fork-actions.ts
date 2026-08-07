import { midnightAbi, Offer, OfferUtils, Tree } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import {
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  maxUint256,
  pad,
  parseAbiParameters,
  publicActions,
  toHex
} from 'viem'
import { base } from 'viem/chains'

import type { AnvilHandle } from './anvil'
import type { RouterApiHandle } from './router-api'

import { prepareBootstrapRequirements } from '../../src/infrastructure/bootstrap/bootstrap-requirements.utils'
import { bootstrapMakeLendArguments } from '../../src/infrastructure/bootstrap/production-bootstrap'
import {
  ANVIL_DEFAULT_ACCOUNT,
  ANVIL_TAKER_ACCOUNT,
  CBBTC,
  ECRECOVER_RATIFIER,
  MARKET,
  MARKET_ID,
  USDC
} from './constants'

const TOKEN_BALANCE_STORAGE_SLOT = 9n
const TAKER_COLLATERAL = 100_000_000n

const tokenBalanceStorageKey = (account: `0x${string}`) =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256'), [
      account,
      TOKEN_BALANCE_STORAGE_SLOT
    ])
  )

/**
 * Executes a real partial or full maker-lend fill through Morpho SDK and forked Midnight contracts.
 * @param anvil - Running Base fork.
 * @param router - Stateful HTTP Router boundary indexing published payloads.
 * @param assets - Positive USDC assets borrowed from the maker offer.
 * @returns Successful fork transaction receipt.
 * @throws When the Router has no buy offer or any SDK requirement/simulation/transaction fails.
 * @remarks Funds only the disposable fork taker through a pinned token storage-layout fixture.
 */
export const takeMakerLend = async (
  anvil: AnvilHandle,
  router: RouterApiHandle,
  assets: bigint
) => {
  const active = await router.activeOffers()
  const item = active.find(candidate => OfferUtils.toStruct({ offer: candidate.offer }).buy)
  if (!item) throw new TypeError('Expected an active maker-lend offer')

  await anvil.client.setStorageAt({
    address: CBBTC,
    index: tokenBalanceStorageKey(ANVIL_TAKER_ACCOUNT.address),
    value: pad(toHex(TAKER_COLLATERAL), { size: 32 })
  })
  const wallet = createWalletClient({
    account: ANVIL_TAKER_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = wallet.morpho.midnight(base.id)
  const marketData = await midnight.getMarketData(MARKET_ID)
  const offer = OfferUtils.toStruct({ offer: item.offer })
  const output = midnight.supplyCollateralTakeBorrow({
    accountAddress: ANVIL_TAKER_ACCOUNT.address,
    marketData,
    collateralAssets: TAKER_COLLATERAL,
    loanAssets: assets,
    maxUnits: assets * 2n,
    takeableOffers: [{ units: assets * 2n, offer, ratifierData: item.ratifierData }],
    deadline: maxUint256
  })
  for (const requirement of await output.getRequirements()) {
    if ('sign' in requirement) throw new TypeError('Unexpected signing requirement for taker fill')
    const hash = await wallet.sendTransaction({
      to: requirement.to,
      data: requirement.data,
      value: requirement.value
    })
    const receipt = await wallet.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new TypeError('Taker requirement reverted')
  }
  const hash = await wallet.sendTransaction(output.buildTx())
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('Maker-lend take reverted')
  const block = await wallet.getBlock({ blockTag: 'latest' })
  const makerPosition = (
    await midnight.getPositionData({
      marketId: MARKET_ID,
      accountAddress: offer.maker,
      parameters: { blockNumber: block.number }
    })
  ).accrueInterest(block.timestamp)
  return { receipt, makerPosition }
}

/** Repays the fork taker's real Midnight debt so maker credit becomes fully withdrawable. */
export const repayTakerDebt = async (anvil: AnvilHandle) => {
  await anvil.client.setStorageAt({
    address: USDC,
    index: tokenBalanceStorageKey(ANVIL_TAKER_ACCOUNT.address),
    value: pad(toHex(2_000_000_000n), { size: 32 })
  })
  const wallet = createWalletClient({
    account: ANVIL_TAKER_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = wallet.morpho.midnight(base.id)
  const marketData = await midnight.getMarketData(MARKET_ID)
  const output = midnight.repayWithdrawCollateral({
    accountAddress: ANVIL_TAKER_ACCOUNT.address,
    marketData,
    repayAssets: 500_000_000n,
    withdrawCollateralAssets: 0n,
    deadline: maxUint256
  })
  for (const requirement of await output.getRequirements()) {
    if ('sign' in requirement) throw new TypeError('Unexpected signing requirement for repayment')
    const hash = await wallet.sendTransaction({
      to: requirement.to,
      data: requirement.data,
      value: requirement.value
    })
    await wallet.waitForTransactionReceipt({ hash })
  }
  const hash = await wallet.sendTransaction(output.buildTx())
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('Taker repayment reverted')
  return receipt
}

/**
 * Redeems all maker credit through the real SDK and forked Midnight contract.
 * @param anvil - Running Base fork.
 * @param maker - Maker account bound to the production runtime.
 * @returns Successful redemption receipt, or undefined when no credit remains.
 */
export const redeemMakerCredit = async (
  anvil: AnvilHandle,
  maker: typeof import('./constants').ANVIL_DEFAULT_ACCOUNT
) => {
  const wallet = createWalletClient({ account: maker, chain: base, transport: http(anvil.rpcUrl) })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = wallet.morpho.midnight(base.id)
  const block = await wallet.getBlock({ blockTag: 'latest' })
  const position = (
    await midnight.getPositionData({
      marketId: MARKET_ID,
      accountAddress: maker.address,
      parameters: { blockNumber: block.number }
    })
  ).accrueInterest(block.timestamp)
  if (position.credit === 0n) return undefined
  const hash = await wallet.sendTransaction(
    midnight.redeem({ accountAddress: maker.address, positionData: position }).buildTx()
  )
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('Maker credit redemption reverted')
  return receipt
}

const seedExternalMakerCredit = async (anvil: AnvilHandle, router: RouterApiHandle) => {
  const wallet = createWalletClient({
    account: ANVIL_TAKER_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = wallet.morpho.midnight(base.id)
  const marketData = await midnight.getMarketData(MARKET_ID)
  await anvil.client.setStorageAt({
    address: USDC,
    index: tokenBalanceStorageKey(ANVIL_TAKER_ACCOUNT.address),
    value: pad(toHex(2_000_000n), { size: 32 })
  })
  const approvalHash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [MARKET.midnight, maxUint256]
  })
  if ((await wallet.waitForTransactionReceipt({ hash: approvalHash })).status !== 'success') {
    throw new TypeError('External maker seed approval reverted')
  }
  const lendOffer = Offer.create({
    market: marketData.params,
    buy: true,
    maker: ANVIL_TAKER_ACCOUNT.address,
    tick: 6_744n,
    expiry: marketData.params.maturity,
    ratifier: ECRECOVER_RATIFIER,
    maxAssets: 1_000_000n,
    continuousFeeCap: BigInt(marketData.continuousFee)
  })
  const publication = await midnight.makeLend(
    bootstrapMakeLendArguments({
      accountAddress: ANVIL_TAKER_ACCOUNT.address,
      offers: [lendOffer],
      validation: { apiUrl: `${router.baseUrl}/v0/midnight` },
      loanToken: USDC,
      loanAssets: 1_000_000n,
      reservedLoanAssets: 0n
    })
  )
  const { signatures: publicationSignatures } = await prepareBootstrapRequirements(
    await publication.getRequirements(),
    (requirement, account) => requirement.sign(wallet, account) as never,
    {
      kind: 'ecrecover',
      target: ECRECOVER_RATIFIER,
      root: Tree.create([lendOffer]).root,
      account: ANVIL_TAKER_ACCOUNT.address,
      offers: 1
    }
  )
  const publicationHash = await wallet.sendTransaction(
    publication.buildTx(publicationSignatures as Parameters<typeof publication.buildTx>[0])
  )
  if ((await wallet.waitForTransactionReceipt({ hash: publicationHash })).status !== 'success') {
    throw new TypeError('External maker seed publication reverted')
  }

  const item = (await router.activeOffers()).find(candidate => {
    const offer = OfferUtils.toStruct({ offer: candidate.offer })
    return offer.buy && offer.maker === ANVIL_TAKER_ACCOUNT.address
  })
  if (!item) throw new TypeError('Expected external maker seed offer')
  await anvil.client.setStorageAt({
    address: CBBTC,
    index: tokenBalanceStorageKey(ANVIL_DEFAULT_ACCOUNT.address),
    value: pad(toHex(TAKER_COLLATERAL), { size: 32 })
  })
  const borrower = createWalletClient({
    account: ANVIL_DEFAULT_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const seedOffer = OfferUtils.toStruct({ offer: item.offer })
  const take = borrower.morpho.midnight(base.id).supplyCollateralTakeBorrow({
    accountAddress: ANVIL_DEFAULT_ACCOUNT.address,
    marketData,
    collateralAssets: TAKER_COLLATERAL,
    loanAssets: 1_000_000n,
    maxUnits: 2_000_000n,
    takeableOffers: [{ units: 2_000_000n, offer: seedOffer, ratifierData: item.ratifierData }],
    deadline: maxUint256
  })
  for (const requirement of await take.getRequirements()) {
    if ('sign' in requirement) throw new TypeError('Unexpected signing requirement for seed fill')
    const hash = await borrower.sendTransaction({
      to: requirement.to,
      data: requirement.data,
      value: requirement.value
    })
    if ((await borrower.waitForTransactionReceipt({ hash })).status !== 'success') {
      throw new TypeError('External maker seed requirement reverted')
    }
  }
  const takeHash = await borrower.sendTransaction(take.buildTx())
  if ((await borrower.waitForTransactionReceipt({ hash: takeHash })).status !== 'success') {
    throw new TypeError('External maker seed fill reverted')
  }
}

/** Publishes one real external maker-sell offer at an exact tick through SDK and mempool. */
export const publishMakerSell = async (
  anvil: AnvilHandle,
  router: RouterApiHandle,
  tick: bigint
) => {
  const wallet = createWalletClient({
    account: ANVIL_TAKER_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = wallet.morpho.midnight(base.id)
  const authorizationHash = await wallet.writeContract({
    address: MARKET.midnight,
    abi: midnightAbi,
    functionName: 'setIsAuthorized',
    args: [ECRECOVER_RATIFIER, true, ANVIL_TAKER_ACCOUNT.address]
  })
  const authorizationReceipt = await wallet.waitForTransactionReceipt({ hash: authorizationHash })
  if (authorizationReceipt.status !== 'success') {
    throw new TypeError('External maker authorization reverted')
  }
  await seedExternalMakerCredit(anvil, router)
  const marketData = await midnight.getMarketData(MARKET_ID)
  const offer = Offer.create({
    market: marketData.params,
    buy: false,
    maker: ANVIL_TAKER_ACCOUNT.address,
    tick,
    expiry: marketData.params.maturity,
    ratifier: ECRECOVER_RATIFIER,
    reduceOnly: true,
    maxUnits: 1_000_000n,
    continuousFeeCap: BigInt(marketData.continuousFee)
  })
  const output = await midnight.makeBorrow({
    accountAddress: ANVIL_TAKER_ACCOUNT.address,
    offers: [offer],
    validation: { apiUrl: `${router.baseUrl}/v0/midnight` }
  })
  const { signatures } = await prepareBootstrapRequirements(
    await output.getRequirements(),
    (requirement, account) => requirement.sign(wallet, account) as never,
    {
      kind: 'ecrecover',
      target: ECRECOVER_RATIFIER,
      root: Tree.create([offer]).root,
      account: ANVIL_TAKER_ACCOUNT.address,
      offers: 1
    }
  )
  const hash = await wallet.sendTransaction(
    output.buildTx(signatures as Parameters<typeof output.buildTx>[0])
  )
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('External sell publication reverted')
  return receipt
}

/** Clears the maker's USDC wallet balance through the pinned real-token storage fixture. */
export const clearMakerCash = (anvil: AnvilHandle) =>
  anvil.client.setStorageAt({
    address: USDC,
    index: tokenBalanceStorageKey(ANVIL_DEFAULT_ACCOUNT.address),
    value: pad(toHex(0n), { size: 32 })
  })
