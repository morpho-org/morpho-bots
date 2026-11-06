import type { Tree } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  midnightAbi,
  midnightBundlesAbi,
  Offer,
  OfferUtils,
  Payload
} from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddressEqual,
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

import {
  ANVIL_BORROWER_ACCOUNT,
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

const tokenBalanceStorageKey = (account: Address) =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256'), [
      account,
      TOKEN_BALANCE_STORAGE_SLOT
    ])
  )

const sellExactUnits = <T extends { data: Hex }>(transaction: T, units: bigint): T => {
  const { functionName, args } = decodeFunctionData({
    abi: midnightBundlesAbi,
    data: transaction.data
  })
  if (functionName !== 'midnightBundlesV1SupplyCollateralAndSellWithAssetsTarget') {
    throw new TypeError(`Unexpected maker-lend take bundle ${functionName}`)
  }
  const [, , ...rest] = args
  return {
    ...transaction,
    data: encodeFunctionData({
      abi: midnightBundlesAbi,
      functionName: 'midnightBundlesV1SupplyCollateralAndSellWithUnitsTarget',
      args: [units, 0n, ...rest]
    })
  }
}

/**
 * Executes a real partial or full maker-lend fill through Morpho SDK and forked Midnight contracts.
 * @param anvil - Running Base fork.
 * @param router - Stateful HTTP Router boundary indexing published payloads.
 * @param target - Positive USDC assets borrowed from the maker offer, or the exact credit units to
 * sell into it, which is how a take consumes all of a units cap.
 * @returns Successful fork transaction receipt.
 * @throws When the Router has no buy offer or any SDK requirement/simulation/transaction fails.
 * @remarks Funds only the disposable fork taker through a pinned token storage-layout fixture.
 */
/** Signs a fixture maker's own root-signature requirements; the bot under test never signs this way. */
const signFixtureRequirements = (wallet: unknown, requirements: readonly unknown[]) =>
  Promise.all(
    requirements.map(requirement =>
      (requirement as { sign: (wallet: unknown, account: Address) => Promise<unknown> }).sign(
        wallet,
        ANVIL_TAKER_ACCOUNT.address
      )
    )
  )

export const takeMakerLend = async (
  anvil: AnvilHandle,
  router: RouterApiHandle,
  target: bigint | { units: bigint }
) => {
  const amount = typeof target === 'bigint' ? target : target.units
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
    loanAssets: amount,
    maxUnits: amount * 2n,
    takeableOffers: [{ units: amount * 2n, offer, ratifierData: item.ratifierData }],
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
  const hash = await wallet.sendTransaction(
    typeof target === 'bigint' ? output.buildTx() : sellExactUnits(output.buildTx(), target.units)
  )
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
  const publication = await midnight.makeLend({
    accountAddress: ANVIL_TAKER_ACCOUNT.address,
    offers: [lendOffer],
    validation: { apiUrl: `${router.baseUrl}/v0/midnight` },
    loanToken: USDC,
    loanAssets: 1_000_000n,
    reservedLoanAssets: 0n
  })
  const publicationSignatures = await signFixtureRequirements(
    wallet,
    await publication.getRequirements()
  )
  const publicationHash = await wallet.sendTransaction(
    publication.buildTx(publicationSignatures as Parameters<typeof publication.buildTx>[0])
  )
  if ((await wallet.waitForTransactionReceipt({ hash: publicationHash })).status !== 'success') {
    throw new TypeError('External maker seed publication reverted')
  }

  const item = (await router.activeOffers()).find(candidate => {
    const offer = OfferUtils.toStruct({ offer: candidate.offer })
    return offer.buy && isAddressEqual(offer.maker, ANVIL_TAKER_ACCOUNT.address)
  })
  if (!item) throw new TypeError('Expected external maker seed offer')
  await anvil.client.setStorageAt({
    address: CBBTC,
    index: tokenBalanceStorageKey(ANVIL_BORROWER_ACCOUNT.address),
    value: pad(toHex(TAKER_COLLATERAL), { size: 32 })
  })
  const borrower = createWalletClient({
    account: ANVIL_BORROWER_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const seedOffer = OfferUtils.toStruct({ offer: item.offer })
  const take = borrower.morpho.midnight(base.id).supplyCollateralTakeBorrow({
    accountAddress: ANVIL_BORROWER_ACCOUNT.address,
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
  const signatures = await signFixtureRequirements(wallet, await output.getRequirements())
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

const fixtureWallet = (anvil: AnvilHandle, account: typeof ANVIL_TAKER_ACCOUNT) =>
  createWalletClient({ account, chain: base, transport: http(anvil.rpcUrl) })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))

const sendRequirements = async (
  wallet: ReturnType<typeof fixtureWallet>,
  requirements: readonly unknown[],
  what: string
) => {
  for (const requirement of requirements) {
    if (typeof requirement === 'object' && requirement !== null && 'sign' in requirement)
      throw new TypeError(`Unexpected signing requirement for ${what}`)
    const { to, data, value } = requirement as { to: Address; data: Hex; value?: bigint }
    const hash = await wallet.sendTransaction({ to, data, value })
    if ((await wallet.waitForTransactionReceipt({ hash })).status !== 'success') {
      throw new TypeError(`${what} requirement reverted`)
    }
  }
}

/**
 * Publishes a tree the fixture maker signs, after supplying cbBTC collateral so its non-reduce-only
 * sells borrow when taken.
 */
export const publishCollateralizedTree = async (anvil: AnvilHandle, tree: Tree) => {
  const maker = ANVIL_TAKER_ACCOUNT
  const wallet = fixtureWallet(anvil, maker)
  const midnight = wallet.morpho.midnight(base.id)
  const authorizationHash = await wallet.writeContract({
    address: MARKET.midnight,
    abi: midnightAbi,
    functionName: 'setIsAuthorized',
    args: [ECRECOVER_RATIFIER, true, maker.address]
  })
  if ((await wallet.waitForTransactionReceipt({ hash: authorizationHash })).status !== 'success') {
    throw new TypeError('Fixture maker authorization reverted')
  }
  await anvil.client.setStorageAt({
    address: CBBTC,
    index: tokenBalanceStorageKey(maker.address),
    value: pad(toHex(TAKER_COLLATERAL), { size: 32 })
  })
  const supply = midnight.supplyCollateral({
    accountAddress: maker.address,
    marketData: await midnight.getMarketData(MARKET_ID),
    collateralAssets: TAKER_COLLATERAL
  })
  await sendRequirements(wallet, await supply.getRequirements(), 'collateral supply')
  const supplyHash = await wallet.sendTransaction(supply.buildTx())
  if ((await wallet.waitForTransactionReceipt({ hash: supplyHash })).status !== 'success') {
    throw new TypeError('Fixture maker collateral supply reverted')
  }
  const typedData = EcrecoverRatifierUtils.typedData({ tree, chainId: base.id })
  const signature = await maker.signTypedData(
    typedData as Parameters<typeof maker.signTypedData>[0]
  )
  const items = await EcrecoverRatifierUtils.ratify({ tree, account: maker.address, signature })
  const hash = await wallet.sendTransaction({
    to: getChainAddress(base.id, 'midnightMempool'),
    data: await Payload.encode(items)
  })
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('Fixture tree publication reverted')
  return receipt
}

/**
 * Prepares a lender's take of the first active sell offer, funding and approving it, without
 * sending the take itself.
 * @returns A function that sends the take, rejecting when its gas estimate reverts.
 */
export const prepareMakerBorrowTake = async (
  anvil: AnvilHandle,
  router: RouterApiHandle,
  assets: bigint
) => {
  const active = await router.activeOffers()
  const item = active.find(candidate => !OfferUtils.toStruct({ offer: candidate.offer }).buy)
  if (!item) throw new TypeError('Expected an active maker-borrow offer')
  await anvil.client.setStorageAt({
    address: USDC,
    index: tokenBalanceStorageKey(ANVIL_BORROWER_ACCOUNT.address),
    value: pad(toHex(assets), { size: 32 })
  })
  const wallet = fixtureWallet(anvil, ANVIL_BORROWER_ACCOUNT)
  const midnight = wallet.morpho.midnight(base.id)
  const offer = OfferUtils.toStruct({ offer: item.offer })
  const output = midnight.takeLend({
    accountAddress: ANVIL_BORROWER_ACCOUNT.address,
    marketData: await midnight.getMarketData(MARKET_ID),
    assets,
    minUnits: 0n,
    takeableOffers: [{ units: offer.maxUnits, offer, ratifierData: item.ratifierData }],
    deadline: maxUint256
  })
  await sendRequirements(wallet, await output.getRequirements(), 'maker-borrow take')
  const transaction = output.buildTx()
  return { offer, send: () => wallet.sendTransaction(transaction) }
}
