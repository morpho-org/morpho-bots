import type { Address, Hex } from 'viem'

import { runIdAt } from '@repo/controller'
import { createLedgerStore } from '@repo/kernel'
import {
  createDeploylessClient,
  createJournalFileSink,
  createLogger,
  readJournalFile,
  simulateLiquidationExec
} from '@repo/kit'
import { quoteUniswapV3 } from '@repo/swaps'
import { lensKey } from '@repo/utils'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { erc20Abi, isAddressEqual } from 'viem'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ForkHandle, TestClient } from './harness'

import { loadConfig } from '../../src/config'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { liquidatorAccount, liquidatorKernel } from '../../src/kernel'
import { marketId } from '../../src/market'
import { startLiquidator } from '../../src/run'
import { isLiquidatable } from '../../src/runner/eligibility'
import { readBlueLiquidationLens } from '../../src/state/lens.sol'
import { createTickStats } from '../../src/stats'
import {
  deployExecutor,
  FORK_URL,
  fundEth,
  LIQUIDATOR,
  LIQUIDATOR_KEY,
  MARKET,
  MORPHO,
  POOL_FEE,
  SWAP_ROUTER_02,
  seedUnhealthyPosition,
  startFork,
  stopFork,
  testClient
} from './harness'

// Generous slippage: the `amountOutMinimum` is derived from the lens's ORACLE price, which can
// diverge from the pool spot; 5% slack keeps the swap from reverting on that gap without masking a
// broken path.
const SLIPPAGE_BPS = 500
const MAX_FEE_GWEI = '10'
const FINALITY_DEPTH = '2'
const BLOCK_MS = 1_000
const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
const JOURNAL_RUN_CAP_BYTES = 1024 * 1024 * 1024
const LANDED_WITHIN_MS = 90_000

const until = async (done: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + LANDED_WITHIN_MS
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

describe.skipIf(!FORK_URL)(
  'fork: end-to-end liquidation of a seeded Base Morpho Blue position',
  () => {
    let anvil: ForkHandle
    let test: TestClient
    let rpcUrl: string
    let executooor: Address
    let stateDirectory: string
    let borrower: Address

    beforeAll(async () => {
      const fork = await startFork()
      anvil = fork.anvil
      rpcUrl = fork.rpcUrl
      test = testClient(rpcUrl)
      await fundEth(test, LIQUIDATOR)
      executooor = await deployExecutor(test, rpcUrl)
      borrower = await seedUnhealthyPosition(test, rpcUrl)
      stateDirectory = await mkdtemp(join(tmpdir(), 'blue-liquidation-fork-'))
    }, 120_000)

    afterAll(async () => {
      await stopFork(anvil)
      if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true })
    })

    it('liquidates through the kernel, records it in the ledger, and finalizes the journal on a clean stop', async () => {
      const config = loadConfig({
        CHAIN_ID: String(base.id),
        [`FINALITY_${base.id}`]: FINALITY_DEPTH,
        RPC_URL: rpcUrl,
        LIQUIDATOR_PRIVATE_KEY: LIQUIDATOR_KEY,
        MORPHO_API_KEY: 'morpho-key',
        EXECUTOOOR_ADDRESS: executooor,
        KERNEL_STATE_DIR: stateDirectory,
        KERNEL_ENROLLMENT: 'enrolling',
        MAX_FEE_GWEI,
        ALLOW_DETECTION_ONLY: 'true'
      })
      const account = liquidatorAccount(config)
      const logger = createLogger('info', { env: {} })
      const client = createDeploylessClient(config)
      const seeded = await readBlueLiquidationLens(client, MORPHO, [{ params: MARKET, borrower }])
      const reading = seeded.get(lensKey(marketId(MARKET), borrower))
      expect(reading && isLiquidatable(reading), 'the seeded position reads as liquidatable').toBe(
        true
      )
      const kernel = liquidatorKernel({ config, account, logger })
      const journal = await createJournalFileSink({
        directory: join(stateDirectory, 'journal'),
        graph: 'blue-liquidation',
        build: { revision: 'f0f0f0', imageTag: 'fork-test' },
        capacityBytes: JOURNAL_CAPACITY_BYTES,
        runCapBytes: JOURNAL_RUN_CAP_BYTES
      })
      const balanceOf = (token: Address, holder: Address) =>
        test.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [holder]
        })
      const loanBefore = await balanceOf(MARKET.loanToken, LIQUIDATOR)

      const bot = await startLiquidator({
        journal: journal.journal,
        kernel: kernel.live,
        world: {
          discover: async () => ({
            candidates: [{ marketParams: MARKET, borrower }],
            complete: true
          }),
          readLens: (pairs, at) => readBlueLiquidationLens(client, MORPHO, pairs, at.hash as Hex)
        },
        worldValidMs: config.worldValidMs,
        quotes: {
          quoteFor: async (plan, out) => {
            const swap = quoteUniswapV3(
              { router: SWAP_ROUTER_02, fee: POOL_FEE },
              {
                chainId: base.id,
                tokenIn: out.params.collateralToken,
                tokenOut: out.params.loanToken,
                amountIn: plan.seizedAssets,
                slippageBps: SLIPPAGE_BPS,
                // The suite drives one venue directly, so it asks for no economic floor.
                minAcceptableAmountOut: 0n,
                executor: executooor,
                referenceAmountOut: expectedLoanOut(plan, out)
              }
            )
            return {
              kind: 'swap',
              plan: {
                steps: [
                  {
                    tokenIn: out.params.collateralToken,
                    tokenOut: out.params.loanToken,
                    target: swap.target,
                    value: swap.value,
                    callData: swap.callData,
                    amountIn: swap.amountIn,
                    approvalSpender: swap.spender
                  }
                ],
                expectedAmountOut: swap.expectedAmountOut,
                amountOutMinimum: swap.amountOutMinimum
              }
            }
          },
          validForMs: 30_000,
          retryMs: 1_000
        },
        prepare: {
          executor: executooor,
          encode: (market, positionBorrower, seizedAssets, plan) =>
            encodeLiquidationExec({
              executor: executooor,
              morpho: MORPHO,
              market,
              seizedAssets,
              borrower: positionBorrower,
              plan,
              recipient: LIQUIDATOR
            }),
          simulate: data => simulateLiquidationExec(client, { executooor, eoa: LIQUIDATOR, data })
        },
        venue: { concurrency: 1 },
        simulations: 1,
        backoff: { baseBlocks: 1, maxBlocks: 4 },
        runId: runIdAt(Date.now()),
        maxReservations: 1,
        stats: createTickStats(),
        logger
      })
      const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
      const mining = setInterval(() => void test.mine({ blocks: 1 }).catch(() => {}), BLOCK_MS)
      try {
        await Promise.race([
          until(
            async () =>
              (await test.getTransactionCount({ address: LIQUIDATOR })) > 0 &&
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

      const sentCount = await test.getTransactionCount({ address: LIQUIDATOR })
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
      expect(ledger).toMatchObject({ nextNonce: sentCount, nonces: {} })
      expect(await readJournalFile(journal.path)).toMatchObject({ status: 'clean' })

      expect(await balanceOf(MARKET.loanToken, LIQUIDATOR)).toBeGreaterThan(loanBefore)
      expect(await balanceOf(MARKET.loanToken, executooor)).toBe(0n)
      expect(await balanceOf(MARKET.collateralToken, executooor)).toBe(0n)
    }, 180_000)
  }
)
