import type { Address } from 'viem'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { erc20Abi, parseGwei } from 'viem'
import { base } from 'viem/chains'

import type { ForkFixture, ForkHandle, TestClient } from './harness'

import { assertContractDeployed, createDeploylessClient } from '../../src/client'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { simulateLiquidationExec } from '../../src/execution/simulate'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { marketId } from '../../src/market'
import { initialFees } from '../../src/queue/fee-policy'
import { quoteUniswapV3 } from '../../src/quotes/venues/uniswap-v3'
import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'
import { createSigner } from '../../src/signer'
import { plan } from '../../src/sizing/plan'
import { lensKey, readBlueLiquidationLens } from '../../src/state/lens.sol'
import {
  deployExecutor,
  FORK_URL,
  fundEth,
  LIQUIDATOR,
  LIQUIDATOR_KEY,
  MORPHO,
  SWAP_ROUTER_02,
  loadForkFixtureFromEnv,
  startFork,
  stopFork,
  testClient,
  warpBy
} from './harness'

// Generous slippage: the `amountOutMinimum` is derived from the lens's ORACLE price, which can
// diverge from the pool spot; 5% slack keeps the swap from reverting on that gap without masking a
// broken path.
const SLIPPAGE_BPS = 500

// A real, currently-unhealthy (or warp-into-unhealthy) Base Morpho Blue position, pinned at a
// deterministic fork block, with a deep Uniswap pool for its collateral. The suite skips by default
// and runs when `RPC_URL_8453` plus `BLUE_LIQUIDATION_FORK_FIXTURE` are set.
const FIXTURE: ForkFixture | null = loadForkFixtureFromEnv()

describe.skipIf(!FORK_URL || !FIXTURE)(
  'fork: end-to-end liquidation against a real Base Morpho Blue position',
  () => {
    let anvil: ForkHandle
    let test: TestClient
    let executooor: Address
    let cfg: {
      chain: typeof base
      rpcUrl: string
      rpcUrlFallback: undefined
      liquidatorPrivateKey: typeof LIQUIDATOR_KEY
      morpho: Address
      executooorAddress: Address
      maxFeeWei: bigint
    }

    beforeAll(async () => {
      if (!FIXTURE) return
      const fork = await startFork(FIXTURE.forkBlock)
      anvil = fork.anvil
      test = testClient(fork.rpcUrl)
      await fundEth(test, LIQUIDATOR)
      executooor = await deployExecutor(test, fork.rpcUrl)
      if (FIXTURE.warpBySeconds) await warpBy(test, FIXTURE.warpBySeconds)

      cfg = {
        chain: base,
        rpcUrl: fork.rpcUrl,
        rpcUrlFallback: undefined,
        liquidatorPrivateKey: LIQUIDATOR_KEY,
        morpho: MORPHO,
        executooorAddress: executooor,
        maxFeeWei: parseGwei('300')
      }
    }, 60_000)

    afterAll(async () => {
      await stopFork(anvil)
    })

    it('drives lens → plan → swap → exec, lands the tx, and fully drains the Executor', async () => {
      if (!FIXTURE) return
      const { marketParams, borrower, poolFee } = FIXTURE
      const client = createDeploylessClient(cfg)
      await assertContractDeployed(client, executooor, 'EXECUTOOOR_ADDRESS')

      // 1. Fresh lens read — the lens re-derives the id from params and reads accrued state.
      const lensOut = await readBlueLiquidationLens(client, MORPHO, [
        { params: marketParams, borrower }
      ])
      const out = lensOut.get(lensKey(marketId(marketParams), borrower))
      expect(out).toBeDefined()
      if (!out) throw new Error('lens returned no entry')

      // 2. Liquidatable (unhealthy, has debt, valid market).
      expect(isLiquidatable(out)).toBe(true)

      // 3. Seize-exact plan. The successful exec below is the on-chain proof that the contract-derived
      //    repaidShares stayed ≤ borrowShares (no debt-underflow revert).
      const liquidationPlan = plan(planInputFromLens(out))
      expect(liquidationPlan).not.toBeNull()
      if (!liquidationPlan) throw new Error('plan returned null')
      expect(liquidationPlan.seizedAssets).toBeGreaterThan(0n)

      // 4. Single-hop Uniswap-V3 swap (collateral → loan via the operator pool) + the real exec.
      const swap = quoteUniswapV3(
        { router: SWAP_ROUTER_02, fee: poolFee },
        {
          chainId: base.id,
          tokenIn: out.params.collateralToken,
          tokenOut: out.params.loanToken,
          amountIn: liquidationPlan.seizedAssets,
          slippageBps: SLIPPAGE_BPS,
          executor: executooor,
          referenceAmountOut: expectedLoanOut(liquidationPlan, out)
        }
      )
      const data = encodeLiquidationExec({
        executor: executooor,
        morpho: MORPHO,
        market: out.params,
        seizedAssets: liquidationPlan.seizedAssets,
        borrower,
        swap,
        recipient: LIQUIDATOR
      })

      // 5. Simulate the exact broadcast calldata — must be ok before we send.
      const sim = await simulateLiquidationExec(client, { executooor, eoa: LIQUIDATOR, data })
      expect(sim.status).toBe('ok')

      // 6. Broadcast through the real signer path.
      const loanBefore = await test.readContract({
        address: out.params.loanToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [LIQUIDATOR]
      })

      const signer = createSigner(cfg)
      const fees = initialFees(await signer.getBaseFee(), cfg.maxFeeWei)
      const { txHash } = await signer.send({
        to: executooor,
        data,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas
      })
      const receipt = await test.waitForTransactionReceipt({ hash: txHash })
      expect(receipt.status).toBe('success')

      // 7. The EOA gained the loan token, and the Executor ends with neither token.
      const loanAfter = await test.readContract({
        address: out.params.loanToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [LIQUIDATOR]
      })
      expect(loanAfter).toBeGreaterThan(loanBefore)

      const exLoan = await test.readContract({
        address: out.params.loanToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [executooor]
      })
      const exColl = await test.readContract({
        address: out.params.collateralToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [executooor]
      })
      expect(exLoan).toBe(0n)
      expect(exColl).toBe(0n)
    }, 120_000)
  }
)
