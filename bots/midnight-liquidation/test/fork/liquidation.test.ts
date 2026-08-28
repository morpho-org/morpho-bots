import type { SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import {
  assertContractDeployed,
  createDeploylessClient,
  createSigner,
  initialFees,
  simulateLiquidationExec
} from '@repo/bot-kit'
import { quoteUniswapV3 } from '@repo/swaps'
import { lensKey } from '@repo/utils'
import { erc20Abi, parseGwei } from 'viem'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { expectedLoanOut } from '../../src/execution/swap-step'
import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'
import { plan } from '../../src/sizing/plan'
import { readMidnightLiquidationLens } from '../../src/state/lens.sol'
import {
  WETH,
  deployExecutor,
  type ForkHandle,
  fundEth,
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

describe('fork: end-to-end liquidation against a real Base position', () => {
  let anvil: ForkHandle
  let test: TestClient
  let executooor: Address
  let position: SeededPosition
  let cfg: {
    chain: typeof base
    rpcUrl: string
    rpcUrlFallback: undefined
    privateKey: typeof LIQUIDATOR_KEY
    midnight: Address
    executooorAddress: Address
    maxFeeWei: bigint
    priorityFeeWei: bigint
  }

  beforeAll(async () => {
    const fork = await startFork(8547) // see the port registry in harness.ts
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
      rpcUrlFallback: undefined,
      privateKey: LIQUIDATOR_KEY,
      midnight: MIDNIGHT,
      executooorAddress: executooor,
      maxFeeWei: parseGwei('300'),
      priorityFeeWei: parseGwei('0.1')
    }
    // The seed's archive reads through the fork RPC take ~120s end-to-end, so a 120s budget had
    // zero headroom — ordinary provider latency variance made this hook time out intermittently.
  }, 300_000)

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
        // The fork suite drives the venue directly, so it sets its own floor rather than deriving one;
        // 0 means "no economic floor", which is what a raw exec-path test wants.
        minAcceptableAmountOut: 0n,
        executor: executooor,
        referenceAmountOut: expectedLoanOut(liquidationPlan)
      }
    )
    // Wrap the single venue swap as a one-step plan (mirrors quoting.ts' toStep projection).
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

    const signer = createSigner(cfg)
    const fees = initialFees(await signer.getBaseFee(), cfg.maxFeeWei, cfg.priorityFeeWei)
    const { txHash } = await signer.send({
      to: executooor,
      data,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    })
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
  }, 300_000)

  it('liquidates a loan-as-collateral position with an EMPTY swap plan', async () => {
    // The whole point of the loan-as-collateral path: the seized assets already ARE the loan token, so
    // there is no venue, no route and no swap step — the callback queue is just the repay approval.
    // Seeded inside this test rather than the shared beforeAll so it reuses the anvil instance and the
    // Executor deploy without adding a second ~120s seed to the hook that every case waits on.
    const client = createDeploylessClient(cfg)
    const selfPosition = await seedLiquidatablePosition(test, cfg.rpcUrl, 'loan-as-collateral')
    // Warp the FULL LIF ramp (not the 300s margin the WETH case uses): the incentive here is only
    // ~60bps at full ramp, and the two ceil-divisions in the contract's repay derivation round it away
    // entirely in the first seconds past maturity, leaving a zero-surplus liquidation.
    await warpTo(test, selfPosition.maturity + 3600n)

    const pairs = [{ id: selfPosition.id, borrower: selfPosition.borrower, caller: executooor }]
    const lensOut = await readMidnightLiquidationLens(client, MIDNIGHT, pairs)
    const out = lensOut.get(lensKey(selfPosition.id, selfPosition.borrower))
    if (!out) throw new Error('lens returned no entry')
    expect(isLiquidatable(out)).toBe(true)

    // The lens returns the slot; the seam decides it needs no swap by comparing tokens.
    const input = planInputFromLens(out)
    expect(input.collaterals).toHaveLength(1)
    expect(input.collaterals[0]?.swapFree).toBe(true)

    // Sized with the SHIPPED headroom floor on: without the swap-free exemption this returns null.
    const liquidationPlan = plan(input, { headroomFloorBps: 3 })
    if (!liquidationPlan) throw new Error('plan returned null')
    expect(liquidationPlan.swapFree).toBe(true)
    expect(liquidationPlan.seizedAssets).toBeGreaterThan(0n)
    // Surplus is real at full ramp — this is what pays for the gas.
    expect(liquidationPlan.impliedRepaidUnits).toBeLessThan(liquidationPlan.seizedAssets)

    const emptyPlan: SwapPlan = {
      steps: [],
      expectedAmountOut: liquidationPlan.seizedAssets,
      amountOutMinimum: liquidationPlan.seizedAssets
    }
    const data = encodeLiquidationExec({
      executor: executooor,
      midnight: MIDNIGHT,
      market: out.market,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      borrower: selfPosition.borrower,
      postMaturityMode: liquidationPlan.postMaturityMode,
      plan: emptyPlan,
      recipient: LIQUIDATOR
    })

    const sim = await simulateLiquidationExec(client, { executooor, eoa: LIQUIDATOR, data })
    expect(sim.status).toBe('ok')

    const usdcBefore = await test.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [LIQUIDATOR]
    })
    const signer = createSigner(cfg)
    const fees = initialFees(await signer.getBaseFee(), cfg.maxFeeWei, cfg.priorityFeeWei)
    const { txHash } = await signer.send({
      to: executooor,
      data,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    })
    const receipt = await test.waitForTransactionReceipt({ hash: txHash })
    expect(receipt.status).toBe('success')

    // Profit landed, and the single sweep drained the Executor — with one token, one sweep must still
    // leave nothing behind.
    const usdcAfter = await test.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [LIQUIDATOR]
    })
    expect(usdcAfter).toBeGreaterThan(usdcBefore)
    expect(
      await test.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [executooor]
      })
    ).toBe(0n)
  }, 300_000)
})
