import type { SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { assertContractDeployed, createDeploylessClient } from '@repo/evm-kit'
import { simulateLiquidationExec } from '@repo/pipeline'
import { quoteUniswapV3 } from '@repo/swaps'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createWalletClient, erc20Abi, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import { isLiquidatable, planInputFromLens } from '../../src/eligibility'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { lensKey, readMidnightLiquidationLens } from '../../src/lens.sol'
import { plan } from '../../src/sizing/plan'
import {
  WETH,
  deployExecutor,
  type ForkHandle,
  fundEth,
  FORK_URL,
  LIQUIDATOR,
  LIQUIDATOR_KEY,
  MIDNIGHT,
  POOL_FEE,
  SWAP_ROUTER_02,
  startFork,
  stopFork,
  testClient,
  type TestClient,
  USDC,
  warpTo
} from './harness'
import { type SeededPosition, seedLiquidatablePosition } from './seed'

// Generous slippage: the seized slot is tiny (<$1) and the WETH/USDC 0.05% pool is deep, but the
// `amountOutMinimum` is derived from the lens's ORACLE price, which can diverge from the pool spot —
// 5% slack keeps the swap from reverting on that gap without masking a broken path.
const SLIPPAGE_BPS = 500

describe.skipIf(!FORK_URL)('fork: end-to-end liquidation against a real Base position', () => {
  let anvil: ForkHandle
  let test: TestClient
  let executooor: Address
  let position: SeededPosition
  let cfg: {
    chain: typeof base
    rpcUrl: string
    midnight: Address
    executooorAddress: Address
  }

  beforeAll(async () => {
    const fork = await startFork()
    anvil = fork.anvil
    test = testClient(fork.rpcUrl)
    await fundEth(test, LIQUIDATOR)
    executooor = await deployExecutor(test, fork.rpcUrl)
    // Mint a fresh liquidatable position on the fork (the deploy has no organic debt). This also
    // exercises the new 336b924a offer typehashes through a real `take`.
    position = await seedLiquidatablePosition(test, fork.rpcUrl)
    // Just past maturity → post-maturity mode. We warp a modest margin (not the full 60-min ramp) to
    // keep the total time-warp small, so the forked WETH oracle's price read stays fresh.
    await warpTo(test, position.maturity + 300n)

    cfg = {
      chain: base,
      rpcUrl: fork.rpcUrl,
      midnight: MIDNIGHT,
      executooorAddress: executooor
    }
  }, 120_000)

  afterAll(async () => {
    await stopFork(anvil)
  })

  it('drives lens → plan → swap → exec, lands the tx, and fully drains the Executor', async () => {
    const client = createDeploylessClient(cfg)
    await assertContractDeployed(client, executooor, 'EXECUTOOOR_ADDRESS')

    // 1. Fresh lens read — the caller is the Executor (whose liquidator gate the lens checks).
    const pairs = [{ id: position.id, borrower: position.borrower, caller: executooor }]
    const lensOut = await readMidnightLiquidationLens(client, MIDNIGHT, pairs)
    const out = lensOut.get(lensKey(position.id, position.borrower))
    expect(out).toBeDefined()
    if (!out) throw new Error('lens returned no entry')

    // 2. Liquidatable in post-maturity mode (we warped past maturity).
    expect(out.blockTimestamp > position.maturity).toBe(true)
    expect(isLiquidatable(out)).toBe(true)

    // 3. Plan: this position is over-collateralized post-maturity (slot ~$6.5 vs ~$0.68 debt), so the
    //    cap binds. Seize-exact pins the largest seize whose contract-derived repaid stays within the
    //    debt (seizing the whole slot would over-repay and revert), and lets the contract ceil-derive
    //    `repaidUnits`. The successful exec below is the on-chain proof that the derived repaid stayed
    //    within the cap (no RCF / debt-underflow revert).
    const liquidationPlan = plan(planInputFromLens(out))
    expect(liquidationPlan).not.toBeNull()
    if (!liquidationPlan) throw new Error('plan returned null')
    expect(liquidationPlan.postMaturityMode).toBe(true)
    expect(liquidationPlan.seizedAssets).toBeGreaterThan(0n)
    expect(liquidationPlan.repaidUnits).toBe(0n)

    // 4. Single-hop Uniswap-V3 swap (WETH → USDC via the operator pool) + the real exec calldata.
    const collateral = out.market.collateralParams[liquidationPlan.collateralIndex]
    if (!collateral) throw new Error('collateral param missing')
    const swap = quoteUniswapV3(
      { router: SWAP_ROUTER_02, fee: POOL_FEE },
      {
        chainId: base.id,
        tokenIn: collateral.token,
        tokenOut: out.market.loanToken,
        amountIn: liquidationPlan.seizedAssets,
        slippageBps: SLIPPAGE_BPS,
        executor: executooor,
        referenceAmountOut: expectedLoanOut(liquidationPlan, out)
      }
    )
    // The plan a plain collateral produces: the venue swap as its single step (what quoting.ts'
    // toStep normalization emits).
    const swapPlan: SwapPlan = {
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
    }
    const data = encodeLiquidationExec({
      executor: executooor,
      midnight: MIDNIGHT,
      market: out.market,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      borrower: position.borrower,
      postMaturityMode: liquidationPlan.postMaturityMode,
      plan: swapPlan,
      recipient: LIQUIDATOR
    })

    // 5. Simulate the exact broadcast calldata — must be ok before we send.
    const sim = await simulateLiquidationExec(client, { executooor, eoa: LIQUIDATOR, data })
    expect(sim.status).toBe('ok')

    // 6. Broadcast through the real signer path.
    const usdcBefore = await test.readContract({
      address: USDC,
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

    // 7. The EOA gained USDC (the liquidation profit) and the shared singleton ends fully drained —
    //    the full-drain / zero-residual invariant (the literal post-state check deferred here).
    const usdcAfter = await test.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [LIQUIDATOR]
    })
    expect(usdcAfter).toBeGreaterThan(usdcBefore)

    const exUsdc = await test.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [executooor]
    })
    const exCbbtc = await test.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [executooor]
    })
    expect(exUsdc).toBe(0n)
    expect(exCbbtc).toBe(0n)
  }, 120_000)
})
