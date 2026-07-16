import type { SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { assertContractDeployed, createDeploylessClient } from '@repo/evm-kit'
import { simulateLiquidationExec } from '@repo/pipeline'
import { createErc4626Unwrapper, quoteUniswapV3, resolveUnwraps } from '@repo/swaps'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createWalletClient, erc20Abi, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { ForkFixture, ForkHandle, TestClient } from './harness'

import { isLiquidatable, planInputFromLens } from '../../src/eligibility'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { lensKey, readBlueLiquidationLens } from '../../src/lens.sol'
import { marketId } from '../../src/market'
import { plan } from '../../src/sizing/plan'
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
      morpho: Address
      executooorAddress: Address
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
        morpho: MORPHO,
        executooorAddress: executooor
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

      // 4. Resolve the unwrap chain (a no-op for plain collateral; a real vault-share fixture
      //    exercises the redeem step end-to-end), then the single-hop Uniswap-V3 swap (resolved
      //    token → loan via the operator pool) as the final step — mirroring quoting.ts' toStep
      //    normalization.
      const unwrapper = createErc4626Unwrapper({
        client,
        logger: { info: () => {}, warn: () => {} }
      })
      const resolution = await resolveUnwraps([unwrapper], {
        token: out.params.collateralToken,
        amountIn: liquidationPlan.seizedAssets,
        executor: executooor,
        stopToken: out.params.loanToken
      })
      const swap = quoteUniswapV3(
        { router: SWAP_ROUTER_02, fee: poolFee },
        {
          chainId: base.id,
          tokenIn: resolution.token,
          tokenOut: out.params.loanToken,
          amountIn: resolution.amountIn,
          slippageBps: SLIPPAGE_BPS,
          executor: executooor,
          referenceAmountOut: expectedLoanOut(liquidationPlan, out)
        }
      )
      const swapPlan: SwapPlan = {
        steps: [
          ...resolution.steps,
          {
            tokenIn: resolution.token,
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
      const data = encodeLiquidationExec({
        executor: executooor,
        morpho: MORPHO,
        market: out.params,
        seizedAssets: liquidationPlan.seizedAssets,
        borrower,
        plan: swapPlan,
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

      const wallet = createWalletClient({
        account: privateKeyToAccount(LIQUIDATOR_KEY),
        chain: base,
        transport: http(cfg.rpcUrl)
      })
      const txHash = await wallet.sendTransaction({ to: executooor, data })
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

      // Any unwrap intermediates (vault-share fixture) must be swept too — the full-drain invariant.
      for (const step of resolution.steps) {
        const exIntermediate = await test.readContract({
          address: step.tokenOut,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [executooor]
        })
        expect(exIntermediate).toBe(0n)
      }
    }, 120_000)
  }
)
