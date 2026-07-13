/**
 * Seeds real, edge-of-liquidation Midnight positions on live Base so the running production
 * liquidation bot discovers and liquidates them.
 *
 * Starting from TWO EOAs that hold only ETH — wallet A (the lender/maker) and wallet B (the
 * borrower/taker) — it mints `--count` WETH/USDC positions, each sized so it is HEALTHY at creation
 * with a `--drawdown-bps` price-drop buffer. Midnight has no `borrow()` and debt does not accrue, so
 * a position can only be created healthy (the `take` seller-health check) and becomes liquidatable
 * when the real WETH oracle price falls by the drawdown. With `--drawdown-bps 0` the positions sit at
 * the very edge and liquidate on the next WETH downtick. Each position is its own market (cloned
 * collateralParams + oracle from a real WETH/USDC market, distinct `rcfThreshold`), so one borrower
 * holds all `--count`.
 *
 * This is a standalone operator tool (like scripts/calibrate-lens-gas.ts) — NOT part of the runner.
 * It IMPORTS bot code but is not imported by it. Every state-changing tx is simulated immediately
 * before sending and the run aborts on the first revert (the first position validates the whole
 * offer/ratifier path before the other N-1 are touched). `--dry-run` runs discovery + all
 * cryptographic self-checks + prints the capital plan, and sends nothing.
 *
 * Run from the bot directory (so the bunfig soltag preload compiles the lens). `--config` is this
 * tool's OWN swap-route file (it needs a WETH route to fund the seed swaps); it is unrelated to the
 * bot's runtime, which no longer uses a swap-config file:
 *   RPC_URL=... PRIVATE_KEY_LENDER=0x... PRIVATE_KEY_BORROWER=0x... \
 *     bun scripts/seed-liquidatable-positions.ts \
 *       --config ./swap.config.json --pair WETH/USDC --count 100 --drawdown-bps 0 --dry-run
 *
 * Never prints secrets (keys, full RPC URL).
 */
import type { AbiEvent, Address, Hex, PublicClient, WalletClient } from 'viem'

import { MidnightAbi } from '@repo/contracts'
import { assertContractDeployed, createDeploylessClient, createLogger } from '@repo/evm-kit'
import { parseSwapConfig } from '@repo/swaps'
import { delay as sleep, tryCatch } from '@repo/utils'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  formatEther,
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

import type { ApiMarket } from '../src/discovery/markets'
import type { CollateralParams, Market } from '../src/execution/encode-call'
import type { Offer } from './seed/offers'

import { mulDivDown, mulDivUp } from '../src/sizing/math'
import { lensKey, readMidnightLiquidationLens } from '../src/state/lens.sol'
import { ORACLE_ABI, SWAP_ROUTER_ABI, WETH_ABI } from './seed/abis'
import { encodeRatifierData, hashOffer, isLeaf, signOfferTree, toId } from './seed/offers'
import { DEFAULT_TICK_SPACING, priceToTick, tickToPrice } from './seed/price-tick'
import { priceDropToLiquidateBps, sizePosition } from './seed/sizing'

const CHAIN_ID = 8453
const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
const PRIVATE_KEY_HEX_LENGTH = 66
const WAD = 10n ** 18n
const ORACLE_PRICE_SCALE = 10n ** 36n
const BPS = 10_000n

// Far-future maturity: keeps every position PRE-maturity (price, not maturity, is the trigger) and
// > 360 days so the settlement fee is the flat top tier. Well under the 100-year `touchMarket` cap.
const MATURITY_HORIZON_SECONDS = 730n * 24n * 60n * 60n
const OFFER_START_BACKDATE = 300n
const OFFER_EXPIRY_AHEAD = 7n * 24n * 60n * 60n
// Offer price ~0.99 (must be ≤ 1 WAD for priceToTick); health uses the ORACLE price, not this.
const TARGET_OFFER_PRICE = 990_000_000_000_000_000n
// Distinct, health-neutral `rcfThreshold` per market. Large ⇒ the slot is RCF-exempt, so the bot
// repays up to the full (post-writeoff) debt in one liquidation rather than a tiny RCF-capped
// partial — a cleaner test. Safe because `plan()` bounds the repay by the debt before seizing the
// whole slot (src/sizing/plan.ts); without that guard an exempt over-collateralized position
// over-derives repaidUnits > debt and the liquidation reverts with a 0x11 underflow.
const RCF_THRESHOLD_BASE = 10n ** 30n
// Extra WETH wallet A swaps beyond the oracle estimate, to absorb DEX slippage + oracle/pool drift.
const SWAP_INPUT_BUFFER_BPS = 1500n
// Rough per-tx gas headroom for the ETH-spend guard preview (Base is cheap; this is a ceiling).
const GAS_PER_TX_WEI = 2_000_000_000_000n
// Production Midnight API — discovery reads its markets + oracles (incl. the curator `trusted_by`
// signal) to pick a real, trusted market to clone, instead of guessing from on-chain take activity.
const MIDNIGHT_API = 'https://api.morpho.org/v0/midnight'
// The configured RPC is a caching proxy with read-after-write lag: a pre-send simulate can transiently
// see stale state (e.g. an approval/balance from a just-mined tx). Re-simulate a few times before
// treating a revert as real — a genuine revert persists across retries and still aborts the run.
const SIMULATE_RETRIES = 8
const RETRY_DELAY_MS = 3000

const TOKENS: Record<string, { address: Address; decimals: number }> = {
  WETH: { address: getAddress('0x4200000000000000000000000000000000000006'), decimals: 18 },
  USDC: { address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), decimals: 6 },
  cbBTC: { address: getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'), decimals: 8 }
}

const TAKE_EVENT = MidnightAbi.find(x => x.type === 'event' && x.name === 'Take') as
  | AbiEvent
  | undefined

type Args = {
  count: number
  config: string
  pair: string
  drawdownBps: number
  notionalUsdc: string
  referenceMarket: Hex | undefined
  ratifier: Address | undefined
  ladder: boolean
  maxSpendEth: string
  maturitySeconds: bigint
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
      count: { type: 'string', default: '100' },
      config: { type: 'string' },
      pair: { type: 'string', default: 'WETH/USDC' },
      'drawdown-bps': { type: 'string', default: '0' },
      'notional-usdc': { type: 'string', default: '1' },
      'reference-market': { type: 'string' },
      ratifier: { type: 'string' },
      ladder: { type: 'boolean', default: false },
      'max-spend-eth': { type: 'string', default: '0.05' },
      'maturity-seconds': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false }
    }
  })
  if (!values.config)
    throw new Error('--config <path> is required (swap-route config; needs a WETH route)')
  const count = Number(values.count)
  const drawdownBps = Number(values['drawdown-bps'])
  if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer')
  if (!Number.isInteger(drawdownBps) || drawdownBps < 0 || drawdownBps >= 10_000) {
    throw new Error('--drawdown-bps must be an integer in [0, 9999]')
  }
  // Seconds from now until each seeded position's maturity. Default is the far-future horizon (keeps
  // positions pre-maturity so a real WETH downtick is the trigger). A near-term value is useful for the
  // fork test, which warps just past maturity to liquidate in post-maturity mode.
  const maturityRaw = values['maturity-seconds']
  if (maturityRaw !== undefined && !/^\d+$/.test(maturityRaw)) {
    throw new Error('--maturity-seconds must be a non-negative integer')
  }
  const maturitySeconds = maturityRaw ? BigInt(maturityRaw) : MATURITY_HORIZON_SECONDS
  return {
    count,
    config: values.config,
    pair: values.pair ?? 'WETH/USDC',
    drawdownBps,
    notionalUsdc: values['notional-usdc'] ?? '1',
    referenceMarket: values['reference-market'] as Hex | undefined,
    ratifier: values.ratifier ? getAddress(values.ratifier) : undefined,
    ladder: values.ladder ?? false,
    maxSpendEth: values['max-spend-eth'] ?? '0.05',
    maturitySeconds,
    dryRun: values['dry-run'] ?? false,
    yes: values.yes ?? false
  }
}

function resolvePair(pair: string) {
  const [collateralSym, loanSym] = pair.split('/')
  const collateral = collateralSym ? TOKENS[collateralSym] : undefined
  const loan = loanSym ? TOKENS[loanSym] : undefined
  if (!collateral || !loan)
    throw new Error(`unknown pair ${pair}; known tokens: ${Object.keys(TOKENS).join(', ')}`)
  return {
    collateral: { ...collateral, symbol: collateralSym! },
    loan: { ...loan, symbol: loanSym! }
  }
}

type Sample = {
  offer: Offer
  cp: CollateralParams
  root: Hex
  leafIndex: bigint
  proof: readonly Hex[]
}

// Decode one tx as a direct `take` whose offer is for the wanted collateral/loan and uses the
// EcrecoverRatifier ratifierData layout. Returns null for anything that doesn't match (bundled
// takes, other markets, other ratifier encodings) so discovery just moves on.
async function loadTakeSample(
  publicClient: PublicClient,
  hash: Hex,
  collateral: Address,
  loan: Address
): Promise<Sample | null> {
  const tx = await tryCatch(publicClient.getTransaction({ hash }))
  if (tx.error || !tx.data.input) return null
  const decoded = tryCatch(() => decodeFunctionData({ abi: MidnightAbi, data: tx.data.input }))
  if (decoded.error || decoded.data.functionName !== 'take') return null
  const offer = decoded.data.args[0] as unknown as Offer
  const ratifierData = decoded.data.args[1]
  const cp = offer.market.collateralParams.find(c => isAddressEqual(c.token, collateral))
  if (!cp || !isAddressEqual(offer.market.loanToken, loan)) return null
  const parsed = tryCatch(() =>
    decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }]
        },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32[]' }
      ],
      ratifierData
    )
  )
  if (parsed.error) return null
  const [, root, leafIndex, proof] = parsed.data
  return { offer, cp, root, leafIndex, proof }
}

type ApiAsset = { chain_id: number; address: Address }
type ApiOracle = {
  chain_id: number
  address: Address
  collateral_assets: ApiAsset[]
  loan_assets: ApiAsset[]
  trusted_by: unknown[]
}

async function fetchMidnight<T>(path: string): Promise<T> {
  const res = await fetch(`${MIDNIGHT_API}${path}`)
  if (!res.ok) throw new Error(`Midnight API GET ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

// Picks a real collateral/loan market whose oracle curators actually trust (the API `trusted_by`
// signal) and returns its collateralParams to clone. Avoids stale/test-oracle markets whose price
// never moves (a position there would sit at the edge but never liquidate).
async function findTrustedMarket({
  collateral,
  loan,
  logger
}: {
  collateral: { address: Address; symbol: string }
  loan: { address: Address; symbol: string }
  logger: ReturnType<typeof createLogger>
}): Promise<CollateralParams> {
  const oracles = (await fetchMidnight<{ data: ApiOracle[] }>('/oracles')).data
  const trusted = new Set(
    oracles
      .filter(
        o =>
          o.chain_id === CHAIN_ID &&
          Array.isArray(o.trusted_by) &&
          o.trusted_by.length > 0 &&
          o.collateral_assets.some(a => isAddressEqual(a.address, collateral.address)) &&
          o.loan_assets.some(a => isAddressEqual(a.address, loan.address))
      )
      .map(o => o.address.toLowerCase())
  )
  if (trusted.size === 0)
    throw new Error(
      `no curator-trusted ${collateral.symbol}/${loan.symbol} oracle in the Midnight API`
    )

  const markets = (await fetchMidnight<{ data: ApiMarket[] }>('/markets')).data
  for (const m of markets) {
    if (m.chain_id !== CHAIN_ID || !isAddressEqual(m.loan_token, loan.address)) continue
    const c = m.collaterals?.find(
      x => isAddressEqual(x.token, collateral.address) && trusted.has(x.oracle.toLowerCase())
    )
    if (!c) continue
    logger.info('seed.reference.market', {
      marketId: m.market_id,
      oracle: c.oracle,
      lltv: c.lltv,
      liquidationCursor: c.liquidation_cursor
    })
    return {
      token: getAddress(c.token),
      lltv: BigInt(c.lltv),
      liquidationCursor: BigInt(c.liquidation_cursor),
      oracle: getAddress(c.oracle)
    }
  }
  throw new Error(
    `no ${collateral.symbol}/${loan.symbol} market with a trusted oracle found; pass --reference-market`
  )
}

// Discovers a deployed EcrecoverRatifier from any recent decodable take (market-independent) and
// cross-checks our hashOffer against that real offer — proving our EIP-712 hashing before we spend.
async function findRatifier({
  publicClient,
  collateral,
  loan,
  logger
}: {
  publicClient: PublicClient
  collateral: { address: Address }
  loan: { address: Address }
  logger: ReturnType<typeof createLogger>
}): Promise<Address> {
  if (!TAKE_EVENT) throw new Error('Take event missing from MidnightAbi')
  const latest = await publicClient.getBlockNumber()
  const window = 2_000n
  const lookback = 100_000n
  const seen = new Set<Hex>()
  for (let to = latest; to > latest - lookback && to > 0n; to -= window) {
    const from = to - window + 1n > 0n ? to - window + 1n : 0n
    const logs = await publicClient.getLogs({
      address: MIDNIGHT,
      event: TAKE_EVENT,
      fromBlock: from,
      toBlock: to
    })
    for (const log of logs) {
      const h = log.transactionHash
      if (!h || seen.has(h)) continue
      seen.add(h)
      const sample = await loadTakeSample(publicClient, h, collateral.address, loan.address)
      if (!sample) continue
      if (
        !isLeaf({
          root: sample.root,
          leafHash: hashOffer(sample.offer),
          leafIndex: sample.leafIndex,
          proof: sample.proof
        })
      ) {
        throw new Error(
          `hashOffer cross-check FAILED against on-chain take ${h} — offer hashing is wrong, aborting`
        )
      }
      logger.info('seed.reference.ratifier', { txHash: h, ratifier: sample.offer.ratifier })
      return getAddress(sample.offer.ratifier)
    }
  }
  throw new Error('no decodable take found for ratifier discovery — pass --ratifier')
}

async function resolveReference({
  publicClient,
  args,
  collateral,
  loan,
  logger
}: {
  publicClient: PublicClient
  args: Args
  collateral: { address: Address; symbol: string }
  loan: { address: Address; symbol: string }
  logger: ReturnType<typeof createLogger>
}): Promise<{ cp: CollateralParams; ratifier: Address }> {
  if (args.referenceMarket && args.ratifier) {
    const market = (await publicClient.readContract({
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'toMarket',
      args: [args.referenceMarket]
    })) as Market
    const cp = market.collateralParams.find(c => isAddressEqual(c.token, collateral.address))
    if (!cp) throw new Error(`reference market has no ${collateral.symbol} collateral`)
    if (!isAddressEqual(market.loanToken, loan.address))
      throw new Error(`reference market loanToken != ${loan.symbol}`)
    logger.warn('seed.reference.override', {
      detail:
        'using --reference-market/--ratifier; trust + hashOffer checks skipped (validated live on first take)',
      oracle: cp.oracle
    })
    return { cp, ratifier: args.ratifier }
  }

  const cp = await findTrustedMarket({ collateral, loan, logger })
  const ratifier = await findRatifier({ publicClient, collateral, loan, logger })
  return { cp, ratifier }
}

type Position = {
  index: number
  id: Hex
  market: Market
  offer: Offer
  ratifierData: Hex
  collateral: bigint
  maxDebt: bigint
  units: bigint
  buyerAssets: bigint
  drawdownBps: number
}

async function buildPositions({
  args,
  cp,
  ratifier,
  loan,
  price,
  tick,
  offerPrice,
  now,
  maker,
  keyA
}: {
  args: Args
  cp: CollateralParams
  ratifier: Address
  loan: { address: Address; decimals: number }
  price: bigint
  tick: bigint
  offerPrice: bigint
  now: bigint
  maker: Address
  keyA: Hex
}): Promise<Position[]> {
  const debtTargetUnits = parseUnits(args.notionalUsdc, loan.decimals)
  const maturity = now + args.maturitySeconds
  const positions: Position[] = []
  for (let i = 0; i < args.count; i++) {
    const drawdownBps =
      args.ladder && args.count > 1
        ? Math.floor((args.drawdownBps * i) / (args.count - 1))
        : args.drawdownBps
    const { collateral, maxDebt, units } = sizePosition({
      price,
      lltv: cp.lltv,
      debtTargetUnits,
      drawdownBps
    })
    const market: Market = {
      chainId: BigInt(CHAIN_ID),
      midnight: MIDNIGHT,
      loanToken: loan.address,
      collateralParams: [cp],
      maturity,
      rcfThreshold: RCF_THRESHOLD_BASE + BigInt(i),
      enterGate: zeroAddress,
      liquidatorGate: zeroAddress
    }
    const id = toId(market)
    const offer: Offer = {
      market,
      buy: true,
      maker,
      start: now - OFFER_START_BACKDATE,
      expiry: now + OFFER_EXPIRY_AHEAD,
      tick,
      group: numberToHex(i, { size: 32 }),
      callback: zeroAddress,
      callbackData: '0x',
      receiverIfMakerIsSeller: zeroAddress,
      ratifier,
      reduceOnly: false,
      maxUnits: units,
      maxAssets: 0n,
      // Uncapped (max uint32): the take reverts if the market's continuousFee exceeds this; USDC's
      // default continuousFee is 0, but max uint32 keeps the seed robust to a nonzero default.
      continuousFeeCap: 4294967295n
    }
    const root = hashOffer(offer)
    const signature = await signOfferTree({ root, privateKey: keyA, ratifier, chainId: CHAIN_ID })
    const ratifierData = encodeRatifierData({ signature, root, leafIndex: 0n, proof: [] })
    // buyerPrice == offerPrice on a buy offer, so buyerAssets is exact without the settlement fee.
    const buyerAssets = mulDivDown(units, offerPrice, WAD)
    positions.push({
      index: i,
      id,
      market,
      offer,
      ratifierData,
      collateral,
      maxDebt,
      units,
      buyerAssets,
      drawdownBps
    })
  }
  return positions
}

function printPlan({
  args,
  positions,
  cp,
  ratifier,
  price,
  offerPrice,
  totals,
  addrA,
  addrB,
  balA,
  balB
}: {
  args: Args
  positions: Position[]
  cp: CollateralParams
  ratifier: Address
  price: bigint
  offerPrice: bigint
  totals: { wethForA: bigint; usdcForA: bigint; wethForB: bigint; ethA: bigint; ethB: bigint }
  addrA: Address
  addrB: Address
  balA: bigint
  balB: bigint
}) {
  const sample = positions[0]!
  const lines = [
    '',
    '================  LIVE BASE MAINNET — REAL FUNDS  ================',
    `pair                : ${args.pair}    positions: ${positions.length}${args.ladder ? '  (laddered drawdown)' : ''}`,
    `oracle/lltv/cursor  : ${cp.oracle}  lltv=${formatUnits(cp.lltv, 18)} liquidationCursor=${formatUnits(cp.liquidationCursor, 18)}`,
    `ratifier            : ${ratifier}`,
    `WETH oracle price   : ${formatUnits(price, 18)} (USDC per WETH, 1e36-scaled)`,
    `offer price / drawdn: ${formatUnits(offerPrice, 18)}  drawdown=${args.drawdownBps}bps (price-drop to liquidate)`,
    `per-position (i=0)  : collateral=${formatUnits(sample.collateral, 18)} WETH  debt=${formatUnits(sample.units, 6)} units  maxDebt=${formatUnits(sample.maxDebt, 6)}`,
    '--- wallet A (lender/maker) ---',
    `  ${addrA}  ETH balance=${formatEther(balA)}`,
    `  acquire ~${formatUnits(totals.usdcForA, 6)} USDC by swapping ~${formatEther(totals.wethForA)} WETH`,
    '--- wallet B (borrower/taker) ---',
    `  ${addrB}  ETH balance=${formatEther(balB)}`,
    `  wrap ${formatEther(totals.wethForB)} ETH → WETH collateral`,
    '--- spend (excl. recoverable principal) ---',
    `  wallet A ETH ~${formatEther(totals.ethA)}   wallet B ETH ~${formatEther(totals.ethB)}   txns ~${3 + 3 + positions.length * 2}`,
    '=================================================================',
    ''
  ]
  process.stderr.write(`${lines.join('\n')}\n`)
}

async function txStep({
  ctx,
  wallet,
  label,
  call
}: {
  ctx: { publicClient: PublicClient; logger: ReturnType<typeof createLogger> }
  wallet: WalletClient
  label: string
  // Heterogeneous contract call across several ABIs; typed loosely on purpose for a one-off script.
  call: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    value?: bigint
  }
}) {
  let sim = await tryCatch(
    ctx.publicClient.simulateContract({ account: wallet.account, ...call } as never)
  )
  for (let attempt = 1; sim.error && attempt < SIMULATE_RETRIES; attempt++) {
    // Likely the caching RPC lagging a just-mined dependency — wait and re-simulate.
    ctx.logger.warn('seed.simulate_retry', { step: label, attempt })
    await sleep(RETRY_DELAY_MS)
    sim = await tryCatch(
      ctx.publicClient.simulateContract({ account: wallet.account, ...call } as never)
    )
  }
  if (sim.error) {
    ctx.logger.error('seed.simulate_failed', { step: label, reason: sim.error.message })
    throw sim.error
  }
  ctx.logger.info('seed.simulate_ok', { step: label })
  const { request, result } = sim.data as unknown as { request: never; result: unknown }
  const hash = await wallet.writeContract(request)
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted on-chain (tx ${hash})`)
  ctx.logger.info('seed.tx', { step: label, txHash: hash })
  return result
}

async function main() {
  const args = parseCliArgs()
  const logger = createLogger('info')
  const rpcUrl = reqEnv('RPC_URL')
  const chainIdEnv = process.env.CHAIN_ID?.trim()
  if (chainIdEnv && chainIdEnv !== String(CHAIN_ID))
    throw new Error(`only Base (${CHAIN_ID}) is supported`)
  const keyA = reqKey('PRIVATE_KEY_LENDER')
  const keyB = reqKey('PRIVATE_KEY_BORROWER')

  // viem's concrete client generics are invariant against the broad `PublicClient`/`WalletClient`
  // aliases the helpers accept, so cast once at the creation site (keeps helper internals typed).
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as PublicClient
  const deploylessClient = createDeploylessClient({
    chain: base,
    rpcUrl
  })
  const accountA = privateKeyToAccount(keyA, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
  const accountB = privateKeyToAccount(keyB, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
  if (isAddressEqual(accountA.address, accountB.address))
    throw new Error('maker and taker keys must differ (SelfTake)')
  const walletA = createWalletClient({
    account: accountA,
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as WalletClient
  const walletB = createWalletClient({
    account: accountB,
    chain: base,
    transport: http(rpcUrl)
  }) as unknown as WalletClient
  logger.info('seed.start', {
    maker: accountA.address,
    taker: accountB.address,
    count: args.count,
    dryRun: args.dryRun
  })

  await assertContractDeployed(publicClient, MIDNIGHT, 'Midnight')

  const { collateral, loan } = resolvePair(args.pair)
  const swapConfig = parseSwapConfig(JSON.parse(readFileSync(args.config, 'utf8')))
  const route = swapConfig[String(CHAIN_ID)]?.[collateral.address]
  if (!route) {
    throw new Error(
      `no swap route for ${collateral.symbol} (${collateral.address}) in ${args.config} — the prod bot also needs it to liquidate`
    )
  }
  // The seed tool acquires the collateral by swapping WETH directly through a Uniswap-V3 router, so it
  // needs a uniswap-v3 route (router + fee). Aggregator venues have no static router for this script.
  if (route.venue !== 'uniswap-v3') {
    throw new Error(
      `seed tool supports only uniswap-v3 routes; ${collateral.symbol} is configured for venue '${route.venue}'`
    )
  }

  const { cp, ratifier } = await resolveReference({ publicClient, args, collateral, loan, logger })
  await assertContractDeployed(publicClient, ratifier, 'EcrecoverRatifier')

  const price = await publicClient.readContract({
    address: cp.oracle,
    abi: ORACLE_ABI,
    functionName: 'price'
  })
  if (price === 0n) throw new Error('oracle returned price 0')

  // Our markets are freshly created, so tickSpacing == DEFAULT_TICK_SPACING. Validate priceToTick's
  // contract directly (spacing-aligned, prices at/above target and ≤ 1 WAD) — a plain round-trip
  // would false-fail in the rounding-flat regions at the price extremes.
  const tick = priceToTick(TARGET_OFFER_PRICE, DEFAULT_TICK_SPACING)
  const offerPrice = tickToPrice(tick)
  if (tick % DEFAULT_TICK_SPACING !== 0n || offerPrice < TARGET_OFFER_PRICE || offerPrice > WAD) {
    throw new Error(`tick self-check failed: tick=${tick} offerPrice=${offerPrice}`)
  }

  const now = (await publicClient.getBlock()).timestamp
  const positions = await buildPositions({
    args,
    cp,
    ratifier,
    loan,
    price,
    tick,
    offerPrice,
    now,
    maker: accountA.address,
    keyA
  })

  // Validate the toId port before spending. The contract no longer exposes `toId`, so instead
  // reconstruct a real, known market from `toMarket(referenceMarket)` and assert our local `toId`
  // re-derives its id. A match proves MARKET_TUPLE + the id hashing (incl. the new chainId/midnight
  // fields and liquidationCursor) are correct, hence the seeded positions' ids are too.
  if (args.referenceMarket) {
    const refMarket = (await publicClient.readContract({
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'toMarket',
      args: [args.referenceMarket]
    })) as Market
    const derived = toId(refMarket)
    if (derived.toLowerCase() !== args.referenceMarket.toLowerCase()) {
      throw new Error(
        `toId cross-check failed: derived ${derived} != reference ${args.referenceMarket}`
      )
    }
    logger.info('seed.selfcheck_ok', { toId: true, tickRoundTrip: true })
  } else {
    logger.warn('seed.selfcheck_skipped', {
      detail: 'no --reference-market; toId port not cross-checked against a known id'
    })
  }

  const usdcForA = positions.reduce((sum, p) => sum + p.buyerAssets, 0n)
  const wethForB = positions.reduce((sum, p) => sum + p.collateral, 0n)
  // WETH wallet A must swap to cover usdcForA, padded for slippage + oracle/pool drift.
  const wethForA =
    (mulDivUp(usdcForA, ORACLE_PRICE_SCALE, price) * (BPS + SWAP_INPUT_BUFFER_BPS)) / BPS
  const ratifierAuthed = await publicClient.readContract({
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'isAuthorized',
    args: [accountA.address, ratifier]
  })
  const gasA = GAS_PER_TX_WEI * (ratifierAuthed ? 4n : 5n)
  const gasB = GAS_PER_TX_WEI * BigInt(2 + positions.length * 2)
  const totals = { wethForA, usdcForA, wethForB, ethA: wethForA + gasA, ethB: wethForB + gasB }

  const [balA, balB] = await Promise.all([
    publicClient.getBalance({ address: accountA.address }),
    publicClient.getBalance({ address: accountB.address })
  ])
  printPlan({
    args,
    positions,
    cp,
    ratifier,
    price,
    offerPrice,
    totals,
    addrA: accountA.address,
    addrB: accountB.address,
    balA,
    balB
  })

  const maxSpend = parseUnits(args.maxSpendEth, 18)
  if (totals.ethA + totals.ethB > maxSpend) {
    throw new Error(
      `estimated spend ${formatEther(totals.ethA + totals.ethB)} ETH exceeds --max-spend-eth ${args.maxSpendEth}`
    )
  }
  if (!args.dryRun) {
    if (balA < totals.ethA) {
      throw new Error(
        `wallet A balance ${formatEther(balA)} ETH is below estimated requirement ${formatEther(totals.ethA)} ETH`
      )
    }
    if (balB < totals.ethB) {
      throw new Error(
        `wallet B balance ${formatEther(balB)} ETH is below estimated requirement ${formatEther(totals.ethB)} ETH`
      )
    }
  }

  if (args.dryRun) {
    logger.info('seed.dry_run_complete', { detail: 'self-checks passed; no transactions sent' })
    return
  }
  if (!args.yes && !confirm('Proceed to send REAL transactions on Base mainnet?')) {
    logger.warn('seed.aborted', { detail: 'user declined' })
    return
  }

  const ctx = { publicClient, logger }

  // --- Wallet A: acquire USDC, approve Midnight, authorize the ratifier ---
  await txStep({
    ctx,
    wallet: walletA,
    label: 'A.wrap',
    call: {
      address: TOKENS.WETH!.address,
      abi: WETH_ABI,
      functionName: 'deposit',
      args: [],
      value: wethForA
    }
  })
  await txStep({
    ctx,
    wallet: walletA,
    label: 'A.approveRouter',
    call: {
      address: TOKENS.WETH!.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [route.router, wethForA]
    }
  })
  await txStep({
    ctx,
    wallet: walletA,
    label: 'A.swap',
    call: {
      address: route.router,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: TOKENS.WETH!.address,
          tokenOut: loan.address,
          fee: route.fee,
          recipient: accountA.address,
          amountIn: wethForA,
          amountOutMinimum: usdcForA,
          sqrtPriceLimitX96: 0n
        }
      ]
    }
  })
  // Approve the known required amount (the swap delivered ≥ usdcForA via amountOutMinimum); avoids
  // depending on a post-swap balance read that the caching RPC may serve stale.
  await txStep({
    ctx,
    wallet: walletA,
    label: 'A.approveMidnight',
    call: {
      address: loan.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [MIDNIGHT, usdcForA]
    }
  })
  if (!ratifierAuthed) {
    await txStep({
      ctx,
      wallet: walletA,
      label: 'A.authorizeRatifier',
      call: {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'setIsAuthorized',
        args: [ratifier, true, accountA.address]
      }
    })
  }

  // --- Wallet B: wrap collateral, approve, then per-position supplyCollateral + take ---
  await txStep({
    ctx,
    wallet: walletB,
    label: 'B.wrap',
    call: {
      address: TOKENS.WETH!.address,
      abi: WETH_ABI,
      functionName: 'deposit',
      args: [],
      value: wethForB
    }
  })
  await txStep({
    ctx,
    wallet: walletB,
    label: 'B.approveMidnight',
    call: {
      address: TOKENS.WETH!.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [MIDNIGHT, wethForB]
    }
  })

  for (const p of positions) {
    await txStep({
      ctx,
      wallet: walletB,
      label: `B.supply#${p.index}`,
      call: {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'supplyCollateral',
        args: [p.market, 0n, p.collateral, accountB.address]
      }
    })
    const result = (await txStep({
      ctx,
      wallet: walletB,
      label: `B.take#${p.index}`,
      call: {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'take',
        args: [
          p.offer,
          p.ratifierData,
          p.units,
          accountB.address,
          accountB.address,
          zeroAddress,
          '0x'
        ]
      }
    })) as readonly [bigint, bigint]
    if (p.index === 0 && result[0] !== p.buyerAssets) {
      logger.warn('seed.buyerAssets_mismatch', { expected: p.buyerAssets, actual: result[0] })
    }
    logger.info('seed.position_created', {
      index: p.index,
      id: p.id,
      debt: p.units,
      drawdownBps: p.drawdownBps
    })
  }

  // --- Verify via the bot's own lens (retry: the caching RPC lags the just-landed takes) ---
  const pairs = positions.map(p => ({ id: p.id, borrower: accountB.address, caller: zeroAddress }))
  let lensOut = await readMidnightLiquidationLens(deploylessClient, MIDNIGHT, pairs)
  for (let attempt = 1; attempt < SIMULATE_RETRIES; attempt++) {
    if (!positions.some(p => !lensOut.get(lensKey(p.id, accountB.address))?.hasDebt)) break
    await sleep(RETRY_DELAY_MS)
    lensOut = await readMidnightLiquidationLens(deploylessClient, MIDNIGHT, pairs)
  }
  let healthy = 0
  for (const p of positions) {
    const out = lensOut.get(lensKey(p.id, accountB.address))
    if (out?.valid && out.hasDebt && out.healthy) {
      healthy += 1
      logger.info('seed.verified', {
        index: p.index,
        id: p.id,
        debt: out.debt,
        maxDebt: out.maxDebt,
        priceDropToLiquidateBps: priceDropToLiquidateBps(out.maxDebt, out.debt)
      })
    } else {
      logger.error('seed.verify_failed', {
        index: p.index,
        id: p.id,
        valid: out?.valid,
        hasDebt: out?.hasDebt,
        healthy: out?.healthy
      })
    }
  }
  logger.info('seed.done', {
    created: positions.length,
    healthyAtCreation: healthy,
    borrower: accountB.address,
    detail: `watch the prod bot liquidate these when WETH drops ~${args.drawdownBps}bps`
  })
}

await main()
