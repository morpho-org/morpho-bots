import type { Address } from 'viem'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { erc20Abi, parseGwei } from 'viem'
import { base } from 'viem/chains'

import { assertContractDeployed, createDeploylessClient } from '../../src/client'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { simulateLiquidationExec } from '../../src/execution/simulate'
import { buildSwapStep } from '../../src/execution/swap-step'
import { initialFees } from '../../src/queue/fee-policy'
import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'
import { createSigner } from '../../src/signer'
import { plan } from '../../src/sizing/plan'
import { lensKey, readMidnightLiquidationLens } from '../../src/state/lens.sol'
import {
  CBBTC,
  deployExecutor,
  type ForkHandle,
  fundEth,
  LIQUIDATOR,
  LIQUIDATOR_KEY,
  MIDNIGHT,
  POOL_FEE,
  POSITION,
  SWAP_ROUTER_02,
  startFork,
  stopFork,
  testClient,
  type TestClient,
  USDC,
  warpTo
} from './harness'

// Generous slippage: the seized slot is tiny (~$10) and the cbBTC/USDC 0.01% pool is deep, but the
// `amountOutMinimum` is derived from the lens's ORACLE price, which can diverge from the pool spot —
// 5% slack keeps the swap from reverting on that gap without masking a broken path.
const SLIPPAGE_BPS = 500

describe('fork: end-to-end liquidation against a real Base position', () => {
  let anvil: ForkHandle
  let test: TestClient
  let executooor: Address
  let cfg: {
    chain: typeof base
    rpcUrl: string
    rpcUrlFallback: undefined
    liquidatorPrivateKey: typeof LIQUIDATOR_KEY
    midnight: Address
    executooorAddress: Address
    maxFeeWei: bigint
  }

  beforeAll(async () => {
    const fork = await startFork()
    anvil = fork.anvil
    test = testClient(fork.rpcUrl)
    await fundEth(test, LIQUIDATOR)
    executooor = await deployExecutor(test, fork.rpcUrl)
    // Past maturity + the 15-min LIF ramp → post-maturity mode at full maxLif.
    await warpTo(test, POSITION.maturity + 3600n)

    cfg = {
      chain: base,
      rpcUrl: fork.rpcUrl,
      rpcUrlFallback: undefined,
      liquidatorPrivateKey: LIQUIDATOR_KEY,
      midnight: MIDNIGHT,
      executooorAddress: executooor,
      maxFeeWei: parseGwei('300')
    }
  }, 60_000)

  afterAll(async () => {
    await stopFork(anvil)
  })

  it('drives lens → plan → swap → exec, lands the tx, and fully drains the Executor', async () => {
    const client = createDeploylessClient(cfg)
    await assertContractDeployed(client, executooor, 'EXECUTOOOR_ADDRESS')

    // 1. Fresh lens read — the caller is the Executor (whose liquidator gate the lens checks).
    const pairs = [{ id: POSITION.id, borrower: POSITION.borrower, caller: executooor }]
    const lensOut = await readMidnightLiquidationLens(client, MIDNIGHT, pairs)
    const out = lensOut.get(lensKey(POSITION.id, POSITION.borrower))
    expect(out).toBeDefined()
    if (!out) throw new Error('lens returned no entry')

    // 2. Liquidatable in post-maturity mode (we warped past maturity).
    expect(out.blockTimestamp > POSITION.maturity).toBe(true)
    expect(isLiquidatable(out)).toBe(true)

    // 3. Plan: this position is over-collateralized post-maturity (slot ~$6.5 vs ~$0.68 debt), so the
    //    plan repays the full debt and lets the contract derive the (smaller) seize — seizing the whole
    //    slot would over-repay and revert.
    const liquidationPlan = plan(planInputFromLens(out))
    expect(liquidationPlan).not.toBeNull()
    if (!liquidationPlan) throw new Error('plan returned null')
    expect(liquidationPlan.postMaturityMode).toBe(true)
    expect(liquidationPlan.seizedAssets).toBe(0n)
    expect(liquidationPlan.repaidUnits).toBeGreaterThan(0n)

    // 4. Single-hop swap step (cbBTC → USDC via the operator pool) + the real exec calldata.
    const swapStep = buildSwapStep(
      { router: SWAP_ROUTER_02, fee: POOL_FEE, slippageBps: SLIPPAGE_BPS },
      liquidationPlan,
      out
    )
    const data = encodeLiquidationExec({
      executor: executooor,
      midnight: MIDNIGHT,
      market: out.market,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      borrower: POSITION.borrower,
      postMaturityMode: liquidationPlan.postMaturityMode,
      swapStep,
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
    const fees = initialFees(await signer.getBaseFee(), cfg.maxFeeWei)
    const { txHash } = await signer.send({
      to: executooor,
      data,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    })
    const receipt = await test.waitForTransactionReceipt({ hash: txHash })
    expect(receipt.status).toBe('success')

    // 7. The EOA gained USDC (the liquidation profit) and the shared singleton ends fully drained —
    //    the full-drain / zero-residual invariant (the literal post-state check deferred here from
    //    CRTR-2588).
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
      address: CBBTC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [executooor]
    })
    expect(exUsdc).toBe(0n)
    expect(exCbbtc).toBe(0n)
  }, 120_000)
})
