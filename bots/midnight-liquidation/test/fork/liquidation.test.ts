import type { QuoteOutcome } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { runIdAt } from '@repo/controller'
import { createLedgerStore } from '@repo/kernel'
import {
  createDeploylessClient,
  createJournalFileSink,
  createLogger,
  readJournalFile,
  simulateLiquidationExec,
  TRANSACTION_KERNEL_RESERVATIONS
} from '@repo/kit'
import { createRateLimitedClient, quoteUniswapV3 } from '@repo/swaps'
import { lensKey } from '@repo/utils'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { erc20Abi, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'
import type { ForkHandle, TestClient } from './harness'
import type { SeededPosition } from './seed'

import { loadConfig } from '../../src/config'
import {
  LISTED_MARKETS_MAX_AGE_MS,
  TIME_TO_MAX_LIF,
  TOKEN_PRICES_REFRESH_MS,
  TOKEN_PRICES_VALID_MS
} from '../../src/constants'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { liquidatorAccount, liquidatorKernel } from '../../src/kernel'
import { composeQuoting } from '../../src/quotes'
import { startLiquidator } from '../../src/run'
import { isLiquidatable } from '../../src/runner/eligibility'
import { createPlanSkipLog } from '../../src/runner/plan-skip-log'
import { readMidnightLiquidationLens } from '../../src/state/lens.sol'
import { createTickStats } from '../../src/stats'
import {
  deployExecutor,
  FORK_URL,
  fundEth,
  MIDNIGHT,
  POOL_FEE,
  SWAP_ROUTER_02,
  startFork,
  stopFork,
  testClient,
  USDC,
  WETH,
  warpTo
} from './harness'
import { seedLiquidatablePosition } from './seed'

// Generous slippage: the `amountOutMinimum` is derived from the lens's ORACLE price, which can
// diverge from the pool spot; Midnight's own repay pull still bounds the swap's real output.
const SLIPPAGE_BPS = 500
const MAX_FEE_GWEI = '10'
const MAX_SPEND_ETH = '0.5'
const MAX_GAS_LIMIT = '15000000'
const FINALITY_DEPTH = '2'
const BLOCK_MS = 1_000
const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
const LANDED_WITHIN_MS = 120_000
const SEED_TIMEOUT_MS = 600_000
const RUN_TIMEOUT_MS = 240_000

const until = async (done: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + LANDED_WITHIN_MS
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

describe.skipIf(!FORK_URL)('fork: end-to-end liquidation of seeded Base Midnight positions', () => {
  let anvil: ForkHandle
  let test: TestClient
  let rpcUrl: string
  let executooor: Address
  let weth: SeededPosition
  let loanAsCollateral: SeededPosition
  const stateDirectories: string[] = []

  beforeAll(async () => {
    const fork = await startFork(8547) // see the port registry in harness.ts
    anvil = fork.anvil
    rpcUrl = fork.rpcUrl
    test = testClient(rpcUrl)
    executooor = await deployExecutor(test, rpcUrl)
    weth = await seedLiquidatablePosition(test, rpcUrl)
    loanAsCollateral = await seedLiquidatablePosition(test, rpcUrl, 'loan-as-collateral')
    const lastMaturity =
      weth.maturity > loanAsCollateral.maturity ? weth.maturity : loanAsCollateral.maturity
    // Strictly past the LIF ramp, so the ~60bps loan-as-collateral incentive survives the repay's
    // rounding.
    await warpTo(test, lastMaturity + TIME_TO_MAX_LIF + 1n)
  }, SEED_TIMEOUT_MS)

  afterAll(async () => {
    await stopFork(anvil)
    for (const directory of stateDirectories) await rm(directory, { recursive: true, force: true })
  })

  const balanceOf = (token: Address, holder: Address) =>
    test.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })

  const liquidateThroughKernel = async (position: SeededPosition) => {
    const liquidatorKey = generatePrivateKey()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'midnight-liquidation-fork-'))
    stateDirectories.push(stateDirectory)
    const config = loadConfig({
      CHAIN_ID: String(base.id),
      [`FINALITY_${base.id}`]: FINALITY_DEPTH,
      RPC_URL: rpcUrl,
      LIQUIDATOR_PRIVATE_KEY: liquidatorKey,
      EXECUTOOOR_ADDRESS: executooor,
      KERNEL_STATE_DIR: stateDirectory,
      KERNEL_ENROLLMENT: 'enrolling',
      MAX_FEE_GWEI,
      MAX_SPEND_ETH,
      MAX_GAS_LIMIT,
      ALLOW_BAD_DEBT_ONLY: 'true',
      MORPHO_API_KEY: 'fork-key'
    })
    const account = liquidatorAccount(config)
    const eoa = account.address
    await fundEth(test, eoa)
    const logger = createLogger('info', { env: {} })
    const client = createDeploylessClient(config)
    const pair = { id: position.id, borrower: position.borrower, caller: executooor }
    const readPosition = async () => {
      const read = await readMidnightLiquidationLens(client, MIDNIGHT, [pair])
      return read.get(lensKey(position.id, position.borrower))
    }
    const seeded = await readPosition()
    expect(seeded && isLiquidatable(seeded), 'the seeded position reads as liquidatable').toBe(true)

    const botQuoting = composeQuoting({
      httpClient: createRateLimitedClient({
        apiKeys: {},
        rps: config.quoting.httpRps,
        burst: config.quoting.httpBurst,
        maxRetries: config.quoting.httpMaxRetries,
        timeoutMs: config.quoting.quoteTimeoutMs
      }),
      selector: { refresh: async () => {}, select: () => [] },
      chainId: config.chainId,
      executor: executooor,
      venues: config.venues.enabled,
      baseUrls: {},
      maxRouteImpactBps: config.quoting.maxRouteImpactBps,
      unwrappers: [],
      excludeCollaterals: [],
      logger
    })
    const quotes: QuoteOutcome[] = []
    // The suite has no venue API key, so a slot that sells collateral goes through one Uniswap V3
    // pool, while a loan-as-collateral slot takes the bot's own venue-less, swap-free quote.
    const quoteFor = async (
      plan: LiquidationPlan,
      out: LensOut,
      label: string
    ): Promise<QuoteOutcome> => {
      if (plan.swapFree) {
        const quote = await botQuoting.quoteFor(plan, out, label)
        quotes.push(quote)
        return quote
      }
      const collateral = out.market.collateralParams[plan.collateralIndex]!
      const swap = quoteUniswapV3(
        { router: SWAP_ROUTER_02, fee: POOL_FEE },
        {
          chainId: base.id,
          tokenIn: collateral.token,
          tokenOut: out.market.loanToken,
          amountIn: plan.seizedAssets,
          slippageBps: SLIPPAGE_BPS,
          minAcceptableAmountOut: plan.impliedRepaidUnits,
          executor: executooor,
          referenceAmountOut: expectedLoanOut(plan)
        }
      )
      const quote: QuoteOutcome = {
        kind: 'swap',
        plan: {
          steps: [
            {
              tokenIn: collateral.token,
              tokenOut: out.market.loanToken,
              target: swap.target,
              value: swap.value,
              callData: swap.callData,
              amountIn: swap.amountIn,
              approvalSpender: swap.spender
            }
          ],
          expectedAmountOut: swap.expectedAmountOut,
          amountOutMinimum: swap.amountOutMinimum
        },
        firmCalls: 1
      }
      quotes.push(quote)
      return quote
    }
    const listed = () => [
      { source: 'fork', ids: [position.id.toLowerCase()], updatedAt: Date.now() }
    ]

    const kernel = liquidatorKernel({ config, account, logger })
    const journal = await createJournalFileSink({
      directory: join(stateDirectory, 'journal'),
      graph: 'midnight-liquidation',
      build: { revision: 'f0f0f0', imageTag: 'fork-test' },
      capacityBytes: JOURNAL_CAPACITY_BYTES
    })
    const loanBefore = await balanceOf(USDC, eoa)
    const bot = await startLiquidator({
      journal: journal.journal,
      kernel: kernel.live,
      world: {
        discover: async () => ({
          candidates: [{ marketId: position.id, borrower: position.borrower }],
          complete: true
        }),
        readLens: (pairs, at) =>
          readMidnightLiquidationLens(client, MIDNIGHT, pairs, at.hash as Hex),
        caller: executooor
      },
      worldValidMs: config.worldValidMs,
      prepare: {
        executor: executooor,
        minSurplusBps: config.quoting.minSurplusBps,
        quoteFor,
        encode: (market, borrower, plan, swapPlan) =>
          encodeLiquidationExec({
            executor: executooor,
            midnight: MIDNIGHT,
            market,
            collateralIndex: plan.collateralIndex,
            seizedAssets: plan.seizedAssets,
            repaidUnits: plan.repaidUnits,
            borrower,
            postMaturityMode: plan.postMaturityMode,
            plan: swapPlan,
            recipient: eoa
          }),
        simulate: data => simulateLiquidationExec(client, { executooor, eoa, data }),
        feesFor: async () => ({
          l1Data: 0n,
          baseFee: 0n,
          gasLimit: 0n,
          firstBid: () => ({ maxFeePerGas: 0n, gas: 0n })
        }),
        nativeToken: config.wrappedNative,
        validForMs: config.sendLifeMs,
        now: Date.now
      },
      sizing: {
        seizeCapMarginBps: config.quoting.seizeCapMarginBps,
        headroomFloorBps: config.quoting.headroomFloorBps
      },
      markets: {
        initial: listed(),
        maxAgeMs: LISTED_MARKETS_MAX_AGE_MS,
        refreshMs: config.markets.refreshMs,
        refresh: async () => listed()
      },
      prices: {
        refreshMs: TOKEN_PRICES_REFRESH_MS,
        validForMs: TOKEN_PRICES_VALID_MS,
        refresh: async () => ({ table: {}, updatedAt: Date.now() })
      },
      routes: {
        resolvePair: async () => null,
        sweep: async () => {},
        curveOf: () => undefined,
        venues: config.venues.enabled
      },
      venue: { concurrency: 1 },
      backoff: { baseBlocks: 1, maxBlocks: 4 },
      runId: runIdAt(Date.now()),
      maxReservations: TRANSACTION_KERNEL_RESERVATIONS,
      stats: createTickStats(),
      planSkipLog: createPlanSkipLog(),
      logger
    })
    const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
    const mining = setInterval(() => void test.mine({ blocks: 1 }).catch(() => {}), BLOCK_MS)
    try {
      await Promise.race([
        until(
          async () =>
            (await test.getTransactionCount({ address: eoa })) > 0 &&
            Object.keys(state().nonces).length === 0,
          'a liquidation to land and its nonce to resolve'
        ),
        bot.stopped.then(({ outcome, reason }) => {
          throw new Error(`the kernel stopped first: ${outcome}, ${reason}`)
        })
      ])
      bot.stop()
      expect(await bot.stopped).toMatchObject({ outcome: 'clean' })
    } finally {
      clearInterval(mining)
      await bot.runner.abandon()
    }

    const sentCount = await test.getTransactionCount({ address: eoa })
    for (let nonce = 0; nonce < sentCount; nonce++) {
      const landed = await kernel.live.chain.nonceTx(nonce)
      expect(landed, `nonce ${nonce}`).toMatchObject({ status: 'success' })
      const sent = await test.getTransaction({ hash: landed!.hash as Hex })
      expect(sent.to && isAddressEqual(sent.to, executooor), `nonce ${nonce}`).toBe(true)
    }

    const files = await readdir(stateDirectory, { withFileTypes: true })
    const [ledgerFile, ...others] = files.filter(file => file.isFile())
    expect(others).toStrictEqual([])
    const ledger = await createLedgerStore(join(stateDirectory, ledgerFile!.name)).read()
    expect(ledger).toMatchObject({ nextNonce: sentCount })
    expect(ledger).toHaveProperty('nonces', {})
    expect(await readJournalFile(journal.path)).toMatchObject({ status: 'clean' })

    const after = await readPosition()
    expect(after?.valid, 'the position reads after the liquidation').toBe(true)
    expect(after!.debt).toBeLessThan(seeded!.debt)
    expect(await balanceOf(USDC, eoa)).toBeGreaterThan(loanBefore)
    expect(await balanceOf(USDC, executooor)).toBe(0n)
    expect(await balanceOf(WETH, executooor)).toBe(0n)
    return quotes
  }

  const stepsOf = (quotes: readonly QuoteOutcome[]) =>
    quotes.map(quote => (quote.kind === 'swap' ? quote.plan.steps.length : quote.kind))

  it(
    'swap-liquidates a WETH-collateral position through the kernel and drains the Executor',
    async () => {
      const quotes = await liquidateThroughKernel(weth)
      expect(stepsOf(quotes)).toContain(1)
    },
    RUN_TIMEOUT_MS
  )

  it(
    'liquidates a loan-as-collateral position with an empty swap plan through the kernel',
    async () => {
      const quotes = await liquidateThroughKernel(loanAsCollateral)
      expect(stepsOf(quotes)).toContain(0)
      expect(stepsOf(quotes).every(steps => steps === 0)).toBe(true)
    },
    RUN_TIMEOUT_MS
  )
})
