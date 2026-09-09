/**
 * Seeds one real loan-as-collateral Midnight borrow position on live Base, in a market the running
 * liquidation bot already whitelists, so that market's maturity exercises the bot's swap-free path.
 *
 * A loan-as-collateral slot is one whose token IS the market's loan token, priced by the protocol's
 * identity oracle at exactly `ORACLE_PRICE_SCALE`. That makes the position's health time-invariant:
 * the oracle cannot move, Midnight debt does not accrue, and `take` refuses to mint an unhealthy
 * seller — so unlike `seed-liquidatable-positions.ts`, there is no price drawdown that can make this
 * shape liquidatable. **Maturity is the only trigger**, and the bot liquidates in post-maturity mode
 * once `blockTimestamp > market.maturity`.
 *
 * The market is therefore NOT created here: it must already exist and already be listed, because the
 * bot's whitelist is keyed on exact market id and is fail-closed. Pick one from the markets API and
 * pass its id. There is no order book in these markets, so the position is opened against an offer
 * this script signs itself: wallet A (the lender) posts a bid, wallet B (the borrower) supplies loan
 * -token collateral and takes it, becoming the seller of units and thus the debtor.
 *
 * Every state-changing tx is simulated immediately before sending and the run aborts on the first
 * revert. `--dry-run` performs the full read path and every fail-closed assertion, and sends nothing.
 *
 *   RPC_URL=... PRIVATE_KEY_LENDER=0x... PRIVATE_KEY_BORROWER=0x... \
 *     pnpm --filter @morpho-org/midnight-liquidation run seed:loan-collateral -- \
 *       --markets-api https://… --market 0x… --face-usdc 0.7 --dry-run
 *
 * Never prints secrets (keys, full RPC URL).
 */
import type { Hex, PublicClient, WalletClient } from 'viem'

import { createDeploylessClient, createLogger } from '@repo/bot-kit'
import { Executor } from '@repo/contracts'
import { MidnightAbi } from '@repo/contracts'
import { delay as sleep, lensKey } from '@repo/utils'
import { parseArgs } from 'node:util'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  numberToHex,
  parseUnits,
  zeroAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createNonceManager, jsonRpc } from 'viem/nonce'

import type { Market } from '../src/execution/encode-call'
import type { LensOut } from '../src/state/lens.sol'
import type { Offer } from './seed/offers'

import { BPS, ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { mulDivDown, mulDivUp } from '../src/sizing/math'
import { readMidnightLiquidationLens } from '../src/state/lens.sol'
import { ORACLE_ABI } from './seed/abis'
import { encodeRatifierData, hashOffer, isLeaf, signOfferTree, toId } from './seed/offers'
import { priceToTick, tickToPrice } from './seed/price-tick'
import { confirmPrompt, RETRY_DELAY_MS, SIMULATE_RETRIES, txStep } from './seed/tx'

const CHAIN_ID = 8453
const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
/** `EcrecoverRatifier` on Base — ratifies an offer against a maker's own ECDSA signature. */
const ECRECOVER_RATIFIER = getAddress('0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E')
const PRIVATE_KEY_HEX_LENGTH = 66
const USDC_DECIMALS = 6

/**
 * Offer price, as a WAD discount factor on the units' face value: the borrower receives
 * `face * price` now and owes `face` at maturity. Both sides of the trade are our own wallets, so
 * this is a rounding-headroom choice rather than an economic one — it only has to be ≤ 1 WAD (a
 * `priceToTick` precondition) and leave the borrower's proceeds comfortably above zero.
 */
const DEFAULT_PRICE_WAD = 995_000_000_000_000_000n

/** Backdate the offer start so a stale `block.timestamp` cannot read it as not-yet-started. */
const OFFER_START_BACKDATE = 300n

/**
 * Collateral headroom over the bare `isHealthy` minimum. The take's seller-health check is exact, so
 * this only has to absorb integer rounding — but the residual above the debt is returned to the
 * borrower after liquidation, so it is not a cost.
 */
const DEFAULT_COLLATERAL_MULTIPLE_BPS = 10_500n

/**
 * `SEIZE_CAP_MARGIN_BPS` for Base, mirrored from the bot's chain config so the projected seize this
 * script prints is the one the bot will actually compute.
 */
const SEIZE_CAP_MARGIN_BPS = 30n

type Args = {
  market: Hex
  marketsApi: string
  faceUsdc: string
  collateralMultipleBps: bigint
  priceWad: bigint
  maxSpendUsdc: string
  dryRun: boolean
  yes: boolean
}

function reqEnv(name: string) {
  const v = process.env[name]
  if (!v || !v.trim()) throw new Error(`${name} not set`)
  return v.trim()
}

function reqKey(name: string): Hex {
  const v = reqEnv(name)
  if (!v.startsWith('0x') || v.length !== PRIVATE_KEY_HEX_LENGTH) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`)
  }
  return v as Hex
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      market: { type: 'string' },
      'markets-api': { type: 'string' },
      'face-usdc': { type: 'string', default: '0.7' },
      'collateral-multiple-bps': { type: 'string' },
      'price-wad': { type: 'string' },
      'max-spend-usdc': { type: 'string', default: '5' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false }
    },
    allowPositionals: false
  })

  const market = values.market?.trim()
  if (!market || !/^0x[0-9a-fA-F]{64}$/.test(market)) {
    throw new Error('--market is required and must be a 32-byte hex market id')
  }
  // Required rather than defaulted: the whitelist endpoint decides WHICH deployment's bot will act
  // on the position, and the bot itself takes it from an operator-set variable rather than the repo.
  // Defaulting it would pick an environment on the operator's behalf for a run that spends real funds.
  const marketsApi = values['markets-api']?.trim().replace(/\/$/, '')
  if (!marketsApi) {
    throw new Error(
      '--markets-api is required (the markets endpoint whose `listed=true` set the target bot reads)'
    )
  }
  if (!URL.canParse(marketsApi)) throw new Error(`--markets-api is not a valid URL: ${marketsApi}`)
  const collateralMultipleBps = values['collateral-multiple-bps']
    ? BigInt(values['collateral-multiple-bps'])
    : DEFAULT_COLLATERAL_MULTIPLE_BPS
  if (collateralMultipleBps < BPS) {
    throw new Error('--collateral-multiple-bps must be >= 10000 (never under-collateralize)')
  }
  const priceWad = values['price-wad'] ? BigInt(values['price-wad']) : DEFAULT_PRICE_WAD
  if (priceWad <= 0n || priceWad > WAD) throw new Error('--price-wad must be in (0, 1e18]')

  return {
    market: market as Hex,
    marketsApi,
    faceUsdc: values['face-usdc'],
    collateralMultipleBps,
    priceWad,
    maxSpendUsdc: values['max-spend-usdc'],
    dryRun: values['dry-run'],
    yes: values.yes
  }
}

/**
 * Confirms the target market is listed for this chain on the configured markets API — the same
 * `listed=true` signal that defines the bot's whitelist. Fails closed: an unlisted market is one the
 * bot will discover a position in and then refuse to act on, which is the quiet failure this check
 * exists to prevent.
 */
async function assertListed(deps: { marketsApi: string; market: Hex; logger: Logger }) {
  const url = `${deps.marketsApi}/v0/midnight/markets?market_ids=${deps.market}&listed=true`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    throw new Error(`markets API returned ${response.status} for the target market`)
  }
  const body = (await response.json()) as { data?: { chain_id?: number; listed?: boolean }[] }
  const row = body.data?.find(m => m.chain_id === CHAIN_ID)
  if (!row?.listed) {
    throw new Error(
      `market ${deps.market} is not listed for chain ${CHAIN_ID} on the configured markets API — the bot would never act on it`
    )
  }
  deps.logger.info('seed.market_listed', { market: deps.market, chainId: CHAIN_ID })
}

type Logger = ReturnType<typeof createLogger>

/** The market's loan-as-collateral slot: the index whose token IS the loan token. */
function findLoanCollateralSlot(market: Market): number {
  const index = market.collateralParams.findIndex(cp => isAddressEqual(cp.token, market.loanToken))
  if (index < 0) {
    throw new Error(
      'market has no loan-as-collateral slot (no collateral token equals the loan token)'
    )
  }
  return index
}

/**
 * The seize the bot will compute for this position in post-maturity mode at the start of the LIF
 * ramp — `maxSeizeForCap(cap, price, WAD)` against the margin-shaved debt. Printed and asserted
 * non-zero because a seize that floors to zero is silently skipped as `seize_rounds_to_zero`, which
 * is exactly how the existing dust positions on staging never get liquidated.
 */
function projectedSeize(debt: bigint, price: bigint): bigint {
  const cap = mulDivDown(debt, BPS - SEIZE_CAP_MARGIN_BPS, BPS)
  return mulDivDown(mulDivDown(cap, WAD, WAD), ORACLE_PRICE_SCALE, price)
}

async function main() {
  const args = parseCliArgs()
  const logger = createLogger('info')
  const rpcUrl = reqEnv('RPC_URL')
  const chainIdEnv = process.env.CHAIN_ID?.trim()
  if (chainIdEnv && chainIdEnv !== String(CHAIN_ID)) {
    throw new Error(`only Base (${CHAIN_ID}) is supported`)
  }
  const keyLender = reqKey('PRIVATE_KEY_LENDER')
  const keyBorrower = reqKey('PRIVATE_KEY_BORROWER')

  // viem's concrete client generics are invariant against the broad `PublicClient`/`WalletClient`
  // aliases the helpers accept, so cast once at the creation site.
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as PublicClient
  const deploylessClient = createDeploylessClient({
    chain: base,
    rpcUrl,
    rpcUrlFallback: undefined
  })
  const lender = privateKeyToAccount(keyLender, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
  const borrower = privateKeyToAccount(keyBorrower, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
  if (isAddressEqual(lender.address, borrower.address)) {
    throw new Error('lender and borrower keys must differ (SelfTake)')
  }
  const walletLender = createWalletClient({
    account: lender,
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as WalletClient
  const walletBorrower = createWalletClient({
    account: borrower,
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as WalletClient
  const ctx = { publicClient, logger }

  logger.info('seed.start', {
    market: args.market,
    lender: lender.address,
    borrower: borrower.address,
    dryRun: args.dryRun
  })

  await assertListed({ marketsApi: args.marketsApi, market: args.market, logger })

  // The id is a cryptographic commitment to the Market struct, so reading the struct back and
  // re-deriving the id proves the local `toId` port still matches this deployment before anything
  // is signed against that struct.
  const market = (await publicClient.readContract({
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'toMarket',
    args: [args.market]
  })) as Market
  const derivedId = toId(market)
  if (derivedId.toLowerCase() !== args.market.toLowerCase()) {
    throw new Error(`toId(toMarket(${args.market})) = ${derivedId} — market id self-check FAILED`)
  }
  logger.info('seed.market_selfcheck_ok', { market: args.market })

  if (market.enterGate !== zeroAddress) throw new Error('market has an enterGate; refusing to seed')
  if (market.liquidatorGate !== zeroAddress) {
    throw new Error('market has a liquidatorGate; the bot may be unable to liquidate')
  }
  const latest = await publicClient.getBlock({ blockTag: 'latest' })
  if (market.maturity <= latest.timestamp) {
    throw new Error('market has already matured; a take cannot increase debt post-maturity')
  }

  const slotIndex = findLoanCollateralSlot(market)
  const slot = market.collateralParams[slotIndex]!
  const price = await publicClient.readContract({
    address: slot.oracle,
    abi: ORACLE_ABI,
    functionName: 'price'
  })
  if (price !== ORACLE_PRICE_SCALE) {
    throw new Error(
      `loan-collateral oracle ${slot.oracle} priced ${price}, expected the identity ${ORACLE_PRICE_SCALE}`
    )
  }
  logger.info('seed.slot', {
    collateralIndex: slotIndex,
    token: slot.token,
    lltv: slot.lltv.toString(),
    liquidationCursor: slot.liquidationCursor.toString(),
    oracle: slot.oracle,
    maturity: Number(market.maturity),
    maturityIso: new Date(Number(market.maturity) * 1000).toISOString()
  })

  const tickSpacing = BigInt(
    await publicClient.readContract({
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'tickSpacing',
      args: [args.market]
    })
  )
  const tick = priceToTick(args.priceWad, tickSpacing)
  if (tick % tickSpacing !== 0n)
    throw new Error(`tick ${tick} is not aligned to spacing ${tickSpacing}`)
  const offerPrice = tickToPrice(tick)
  if (offerPrice > WAD) throw new Error(`tick ${tick} prices above 1 WAD`)

  // Sizing. `units` is the face value owed at maturity — the debt. `isHealthy` requires
  // `collateral * price / ORACLE_PRICE_SCALE * lltv / WAD >= debt`, and price is the identity here,
  // so the bare minimum is `units / lltv`; the multiple is rounding headroom on top.
  const units = parseUnits(args.faceUsdc, USDC_DECIMALS)
  if (units <= 0n) throw new Error('--face-usdc must be positive')
  const minCollateral = mulDivUp(units, WAD, slot.lltv)
  const collateral = mulDivUp(minCollateral, args.collateralMultipleBps, BPS)
  const buyerAssets = mulDivDown(units, offerPrice, WAD)
  if (buyerAssets <= 0n) throw new Error('offer price rounds the borrower proceeds to zero')

  const seize = projectedSeize(units, price)
  if (seize <= 0n) {
    throw new Error(
      `projected post-maturity seize rounds to zero for debt ${units} — raise --face-usdc, or the bot will skip this position as seize_rounds_to_zero`
    )
  }

  const maxSpend = parseUnits(args.maxSpendUsdc, USDC_DECIMALS)
  const totalUsdc = collateral + buyerAssets
  if (totalUsdc > maxSpend) {
    throw new Error(
      `plan needs ${formatUnits(totalUsdc, USDC_DECIMALS)} USDC across both wallets, over --max-spend-usdc ${args.maxSpendUsdc}`
    )
  }

  const [lenderUsdc, borrowerUsdc, lenderEth, borrowerEth] = await Promise.all([
    publicClient.readContract({
      address: market.loanToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [lender.address]
    }),
    publicClient.readContract({
      address: market.loanToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [borrower.address]
    }),
    publicClient.getBalance({ address: lender.address }),
    publicClient.getBalance({ address: borrower.address })
  ])

  // The borrower must hold collateral BEFORE the take delivers proceeds, so the lender funds it and
  // keeps `buyerAssets` back to settle its own side of the take.
  const transferToBorrower = collateral > borrowerUsdc ? collateral - borrowerUsdc : 0n
  if (lenderUsdc < buyerAssets + transferToBorrower) {
    throw new Error(
      `lender holds ${formatUnits(lenderUsdc, USDC_DECIMALS)} USDC but needs ${formatUnits(buyerAssets + transferToBorrower, USDC_DECIMALS)} (${formatUnits(buyerAssets, USDC_DECIMALS)} to fund the bid + ${formatUnits(transferToBorrower, USDC_DECIMALS)} to fund the borrower's collateral)`
    )
  }

  const now = latest.timestamp
  const offer: Offer = {
    market,
    buy: true,
    maker: lender.address,
    start: now - OFFER_START_BACKDATE,
    // Past maturity: the offer only has to stay takeable until we take it, and an expiry short of
    // maturity would be rejected as already-expired if the seed lands close to the wire.
    expiry: market.maturity,
    tick,
    // `consumed[maker][group]` accumulates across takes and is capped at the offer's own `maxUnits`,
    // so each seeded position needs a group this maker has not already consumed.
    group: numberToHex(Number(market.maturity), { size: 32 }),
    callback: zeroAddress,
    callbackData: '0x',
    receiverIfMakerIsSeller: zeroAddress,
    ratifier: ECRECOVER_RATIFIER,
    reduceOnly: false,
    maxUnits: units,
    maxAssets: 0n,
    continuousFeeCap: 4_294_967_295n
  }
  const root = hashOffer(offer)
  const signature = await signOfferTree({
    root,
    privateKey: keyLender,
    ratifier: ECRECOVER_RATIFIER,
    chainId: CHAIN_ID
  })
  if (!isLeaf({ root, leafHash: root, leafIndex: 0n, proof: [] })) {
    throw new Error('height-0 offer tree self-check FAILED')
  }
  const ratifierData = encodeRatifierData({ signature, root, leafIndex: 0n, proof: [] })

  const consumed = await publicClient.readContract({
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'consumed',
    args: [lender.address, offer.group]
  })
  if (consumed > 0n) {
    throw new Error(
      `maker has already consumed ${consumed} units in group ${offer.group}; pass a market whose group is unused`
    )
  }

  const ratifierAuthorized = await publicClient.readContract({
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'isAuthorized',
    args: [lender.address, ECRECOVER_RATIFIER]
  })

  process.stderr.write(
    [
      '',
      '================= loan-as-collateral seed plan =================',
      `  market            ${args.market}`,
      `  maturity          ${new Date(Number(market.maturity) * 1000).toISOString()}`,
      `  loan token        ${market.loanToken}`,
      `  collateral slot   index ${slotIndex} (${slot.token}), lltv ${formatUnits(slot.lltv, 18)}`,
      `  offer tick        ${tick} (price ${formatUnits(offerPrice, 18)}, spacing ${tickSpacing})`,
      '',
      `  face / debt       ${formatUnits(units, USDC_DECIMALS)} USDC`,
      `  collateral        ${formatUnits(collateral, USDC_DECIMALS)} USDC (min ${formatUnits(minCollateral, USDC_DECIMALS)})`,
      `  borrower proceeds ${formatUnits(buyerAssets, USDC_DECIMALS)} USDC`,
      `  projected seize   ${formatUnits(seize, USDC_DECIMALS)} USDC at LIF = 1.0`,
      '',
      `  lender    ${lender.address}  ${formatUnits(lenderUsdc, USDC_DECIMALS)} USDC  ${formatUnits(lenderEth, 18)} ETH`,
      `  borrower  ${borrower.address}  ${formatUnits(borrowerUsdc, USDC_DECIMALS)} USDC  ${formatUnits(borrowerEth, 18)} ETH`,
      `  lender -> borrower transfer  ${formatUnits(transferToBorrower, USDC_DECIMALS)} USDC`,
      `  ratifier authorized already  ${ratifierAuthorized}`,
      '================================================================',
      ''
    ].join('\n') + '\n'
  )

  if (args.dryRun) {
    logger.info('seed.dry_run_complete', { market: args.market })
    return
  }
  if (!args.yes && !(await confirmPrompt('Proceed to send REAL transactions on Base mainnet?'))) {
    logger.warn('seed.declined', {})
    return
  }

  if (!ratifierAuthorized) {
    await txStep({
      ctx,
      wallet: walletLender,
      label: 'lender.authorizeRatifier',
      call: {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'setIsAuthorized',
        args: [ECRECOVER_RATIFIER, true, lender.address]
      }
    })
  }
  await txStep({
    ctx,
    wallet: walletLender,
    label: 'lender.approveMidnight',
    call: {
      address: market.loanToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [MIDNIGHT, buyerAssets]
    }
  })
  if (transferToBorrower > 0n) {
    await txStep({
      ctx,
      wallet: walletLender,
      label: 'lender.fundBorrower',
      call: {
        address: market.loanToken,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [borrower.address, transferToBorrower]
      }
    })
  }
  await txStep({
    ctx,
    wallet: walletBorrower,
    label: 'borrower.approveMidnight',
    call: {
      address: market.loanToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [MIDNIGHT, collateral]
    }
  })
  await txStep({
    ctx,
    wallet: walletBorrower,
    label: 'borrower.supplyCollateral',
    call: {
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'supplyCollateral',
      args: [market, BigInt(slotIndex), collateral, borrower.address]
    }
  })
  await txStep({
    ctx,
    wallet: walletBorrower,
    label: 'borrower.take',
    call: {
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'take',
      args: [offer, ratifierData, units, borrower.address, borrower.address, zeroAddress, '0x']
    }
  })

  // Verify through the bot's own lens, so what is asserted is exactly what the bot will read.
  const executor = getAddress(Executor.with().address)
  const pairs = [{ id: args.market, borrower: borrower.address, caller: executor }]
  let out: LensOut | undefined
  for (let attempt = 0; attempt < SIMULATE_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    out = (await readMidnightLiquidationLens(deploylessClient, MIDNIGHT, pairs)).get(
      lensKey(args.market, borrower.address)
    )
    if (out?.hasDebt) break
    logger.warn('seed.lens_retry', { attempt: attempt + 1 })
  }
  if (!out) throw new Error('lens returned no entry for the seeded position')

  const activatedSlots = out.collaterals.map(c => c.index)
  logger.info('seed.verified', {
    market: args.market,
    borrower: borrower.address,
    valid: out.valid,
    hasDebt: out.hasDebt,
    healthy: out.healthy,
    locked: out.locked,
    gateAllows: out.gateAllows,
    debt: out.debt.toString(),
    maxDebt: out.maxDebt.toString(),
    activatedSlots,
    maturityIso: new Date(Number(out.market.maturity) * 1000).toISOString()
  })

  const problems: string[] = []
  if (!out.valid) problems.push('lens reports the market invalid')
  if (!out.hasDebt) problems.push('position carries no debt')
  if (!out.healthy) problems.push('position is already unhealthy')
  if (out.locked) problems.push('position is liquidation-locked')
  if (!out.gateAllows) problems.push('liquidator gate refuses the bot Executor')
  if (activatedSlots.length !== 1 || activatedSlots[0] !== slotIndex) {
    problems.push(
      `expected only the loan-collateral slot ${slotIndex} activated, got [${activatedSlots.join(', ')}]`
    )
  }
  if (problems.length > 0) {
    throw new Error(`seeded position will not be liquidated as intended: ${problems.join('; ')}`)
  }

  logger.info('seed.complete', {
    market: args.market,
    borrower: borrower.address,
    collateralIndex: slotIndex,
    liquidatableAtIso: new Date(Number(out.market.maturity) * 1000).toISOString(),
    projectedSeize: projectedSeize(out.debt, price).toString()
  })
}

await main()
