import type { SwapPlan, SwapStep } from '@repo/swaps'
import type { Hex } from 'viem'

import { decodeAbiParameters, decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../../src/market'

import { WAD } from '../../src/constants'
import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1234567890123456789012345678901234567890')
const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000ee01')
const BORROWER = getAddress('0x000000000000000000000000000000000000b011')
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481')

const MARKET: MarketParams = {
  loanToken: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
  oracle: getAddress('0x1111111111111111111111111111111111111111'),
  irm: getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687'),
  lltv: 86n * 10n ** 16n
}

// Minimal single-purpose ABIs so viem decodes to precise types (no union-narrowing casts needed).
const EXEC_ABI = [
  {
    type: 'function',
    name: 'exec_606BaXt',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: []
  }
] as const

// Matches executooor's `struct Placeholder` exactly (offset/length/resOffset are uint64) — the
// signature must be byte-identical or the callWithPlaceholders selector won't match for decoding.
const PLACEHOLDER_COMPONENTS = [
  { name: 'to', type: 'address' },
  { name: 'data', type: 'bytes' },
  { name: 'offset', type: 'uint64' },
  { name: 'length', type: 'uint64' },
  { name: 'resOffset', type: 'uint64' }
] as const

// The two Executor sub-call shapes buildCall emits; both share (target, value, context, callData) as
// their first four inputs, so args[0]/args[3] decode to a plain hex string on the union.
const SUBCALL_ABI = [
  {
    type: 'function',
    name: 'call_g0oyU7o',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'context', type: 'bytes32' },
      { name: 'callData', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'callWithPlaceholders4845164670',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'context', type: 'bytes32' },
      { name: 'callData', type: 'bytes' },
      { name: 'placeholders', type: 'tuple[]', components: PLACEHOLDER_COMPONENTS }
    ],
    outputs: []
  }
] as const

// Minimal ERC20 subset (approve + transfer) so args[0] decodes to a plain address — the full
// viem erc20Abi has argless functions, which would union args[0] with undefined.
const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  }
] as const

const LIQUIDATE_ABI = [
  {
    type: 'function',
    name: 'liquidate',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'irm', type: 'address' },
          { name: 'lltv', type: 'uint256' }
        ]
      },
      { name: 'borrower', type: 'address' },
      { name: 'seizedAssets', type: 'uint256' },
      { name: 'repaidShares', type: 'uint256' },
      { name: 'data', type: 'bytes' }
    ],
    outputs: []
  }
] as const

// The intermediate underlying an ERC4626 collateral redeems into before the venue swap.
const UNDERLYING = getAddress('0x8888888888888888888888888888888888888888')

function singleStepPlan(step: Omit<SwapStep, 'tokenIn' | 'tokenOut'>): SwapPlan {
  return {
    steps: [{ tokenIn: MARKET.collateralToken, tokenOut: MARKET.loanToken, ...step }],
    expectedAmountOut: 999n * WAD,
    amountOutMinimum: 990n * WAD
  }
}

// A plain-collateral plan: one Uniswap-shaped venue step (live-balance spliced).
const balancePlan = singleStepPlan({
  target: ROUTER,
  value: 0n,
  callData: '0xdeadbeef',
  amountIn: { source: 'balance', offset: 132n },
  approvalSpender: ROUTER
})

// A plain-collateral plan: one aggregator-shaped venue step (route-bound fixed amount).
const fixedPlan = singleStepPlan({
  target: getAddress('0xAbCdeF0000000000000000000000000000000000'),
  value: 0n,
  callData: '0xcafebabe',
  amountIn: { source: 'fixed', value: 5n * WAD },
  approvalSpender: getAddress('0x0000000000001fF3684f28c67538d4D072C22734')
})

// An ERC4626 redeem step: the vault burns the caller's own shares, so no approvalSpender.
const redeemStep = (tokenOut: `0x${string}`): SwapStep => ({
  tokenIn: MARKET.collateralToken,
  tokenOut,
  target: MARKET.collateralToken,
  value: 0n,
  callData: '0xba087652',
  amountIn: { source: 'balance', offset: 4n }
})

// An exotic-collateral plan: redeem the share token to UNDERLYING, then sell it on the venue.
const unwrapThenSwapPlan: SwapPlan = {
  steps: [
    redeemStep(UNDERLYING),
    {
      tokenIn: UNDERLYING,
      tokenOut: MARKET.loanToken,
      target: ROUTER,
      value: 0n,
      callData: '0xdeadbeef',
      amountIn: { source: 'fixed', value: 5n * WAD },
      approvalSpender: ROUTER
    }
  ],
  expectedAmountOut: 999n * WAD,
  amountOutMinimum: 990n * WAD
}

// The unwrap chain ends in the loan token itself — no venue swap step at all.
const unwrapOnlyPlan: SwapPlan = {
  steps: [redeemStep(MARKET.loanToken)],
  expectedAmountOut: 999n * WAD,
  amountOutMinimum: 990n * WAD
}

function encode(plan: SwapPlan): Hex {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    morpho: MORPHO,
    market: MARKET,
    seizedAssets: 3n * WAD,
    borrower: BORROWER,
    plan,
    recipient: RECIPIENT
  })
}

/** The three top-level Executor sub-calls of an exec_606BaXt. */
function execCalls(data: Hex): readonly Hex[] {
  const [calls] = decodeFunctionData({ abi: EXEC_ABI, data }).args
  return calls
}

/** A sub-call's { functionName, target, callData }. */
function decodeSubCall(blob: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: SUBCALL_ABI, data: blob })
  return { functionName, target: getAddress(args[0]), callData: args[3] }
}

/** The [callbackQueue, returnData] a liquidate call rides on. */
function decodeCallback(liquidateCall: Hex): { queue: readonly Hex[]; returnData: Hex } {
  const { args } = decodeFunctionData({
    abi: LIQUIDATE_ABI,
    data: decodeSubCall(liquidateCall).callData
  })
  const [queue, returnData] = decodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes' }], args[4])
  return { queue, returnData }
}

describe('encodeLiquidationExec', () => {
  it('emits exec_606BaXt with exactly [liquidate, skim(loan), skim(collateral)]', () => {
    const { functionName } = decodeFunctionData({ abi: EXEC_ABI, data: encode(balancePlan) })
    expect(functionName).toBe('exec_606BaXt')
    const calls = execCalls(encode(balancePlan))
    expect(calls).toHaveLength(3)

    // Sub-call 0: the liquidate to Morpho.
    expect(decodeSubCall(calls[0]!).target).toBe(MORPHO)
    // Sub-calls 1 & 2: sweep loan then collateral to the EOA.
    expect(decodeSubCall(calls[1]!).target).toBe(MARKET.loanToken)
    expect(decodeSubCall(calls[2]!).target).toBe(MARKET.collateralToken)
  })

  it('encodes Morpho.liquidate with the pinned seize and repaidShares = 0 (seize-exact)', () => {
    const calls = execCalls(encode(balancePlan))
    const { args } = decodeFunctionData({
      abi: LIQUIDATE_ABI,
      data: decodeSubCall(calls[0]!).callData
    })
    const [market, borrower, seizedAssets, repaidShares] = args
    expect(getAddress(market.collateralToken)).toBe(MARKET.collateralToken)
    expect(getAddress(market.loanToken)).toBe(MARKET.loanToken)
    expect(market.lltv).toBe(MARKET.lltv)
    expect(getAddress(borrower)).toBe(BORROWER)
    expect(seizedAssets).toBe(3n * WAD)
    expect(repaidShares).toBe(0n) // seize-exact: contract ceil-derives repaidShares
  })

  it('rides the callback queue in liquidate.data with empty return-data (Blue ignores the callback return)', () => {
    const calls = execCalls(encode(balancePlan))
    const { queue, returnData } = decodeCallback(calls[0]!)
    // 5-call queue: approve(coll,0), approve(coll,bal), swap, approve(loan,0), approve(loan,bal).
    expect(queue).toHaveLength(5)
    expect(returnData).toBe('0x') // no magic-value trick — Morpho ignores onMorphoLiquidate's return
    // The swap call sits at queue index 2, targeting the venue.
    expect(decodeSubCall(queue[2]!).target).toBe(ROUTER)
    // The repay-approval targets Morpho (loan token approve to the singleton).
    const loanApprove = decodeFunctionData({
      abi: ERC20_MIN_ABI,
      data: decodeSubCall(queue[4]!).callData
    })
    expect(loanApprove.functionName).toBe('approve')
    expect(getAddress(loanApprove.args[0])).toBe(MORPHO)
  })

  it('splices the live balance for a Uniswap (balance) swap but not an aggregator (fixed) swap', () => {
    const balanceQueue = decodeCallback(execCalls(encode(balancePlan))[0]!).queue
    // balance swap → callWithPlaceholders (spliced), fixed swap → plain call.
    expect(decodeSubCall(balanceQueue[2]!).functionName).toBe('callWithPlaceholders4845164670')

    const fixedQueue = decodeCallback(execCalls(encode(fixedPlan))[0]!).queue
    expect(decodeSubCall(fixedQueue[2]!).functionName).toBe('call_g0oyU7o')
  })

  it('sweeps transfer the full balance to the recipient EOA', () => {
    const calls = execCalls(encode(balancePlan))
    const skimLoan = decodeFunctionData({
      abi: ERC20_MIN_ABI,
      data: decodeSubCall(calls[1]!).callData
    })
    expect(skimLoan.functionName).toBe('transfer')
    expect(getAddress(skimLoan.args[0])).toBe(RECIPIENT)
  })

  it('prepends an unwrap step: spliced redeem, venue approve pair on the UNDERLYING, extra skim', () => {
    const calls = execCalls(encode(unwrapThenSwapPlan))
    const { queue } = decodeCallback(calls[0]!)
    // 6-call queue: redeem(spliced), approve(underlying→router, 0), approve(underlying→router, bal),
    // swap, approve(loan→morpho, 0), approve(loan→morpho, bal).
    expect(queue).toHaveLength(6)

    // The redeem is balance-spliced on the SHARE token (the collateral), shares word at offset 4.
    const redeem = decodeSubCall(queue[0]!)
    expect(redeem.functionName).toBe('callWithPlaceholders4845164670')
    expect(redeem.target).toBe(MARKET.collateralToken)
    const { args: redeemArgs } = decodeFunctionData({ abi: SUBCALL_ABI, data: queue[0]! })
    const placeholders = redeemArgs[4]!
    expect(placeholders).toHaveLength(1)
    expect(getAddress(placeholders[0]!.to)).toBe(MARKET.collateralToken)
    expect(placeholders[0]!.offset).toBe(4n)

    // The venue approve pair targets the UNDERLYING (the swap's input), not the raw collateral.
    for (const index of [1, 2]) {
      const approve = decodeSubCall(queue[index]!)
      expect(approve.target).toBe(UNDERLYING)
      const decoded = decodeFunctionData({ abi: ERC20_MIN_ABI, data: approve.callData })
      expect(decoded.functionName).toBe('approve')
      expect(getAddress(decoded.args[0])).toBe(ROUTER)
    }
    expect(decodeSubCall(queue[3]!).target).toBe(ROUTER)

    // Outer calls grow one sweep for the intermediate underlying, after the two market-token sweeps.
    expect(calls).toHaveLength(4)
    expect(decodeSubCall(calls[3]!).target).toBe(UNDERLYING)
  })

  it('encodes an unwrap-only plan (chain ends in the loan token): no venue call, no extra skim', () => {
    const calls = execCalls(encode(unwrapOnlyPlan))
    const { queue } = decodeCallback(calls[0]!)
    // 3-call queue: redeem(spliced), approve(loan→morpho, 0), approve(loan→morpho, bal).
    expect(queue).toHaveLength(3)
    expect(decodeSubCall(queue[0]!).target).toBe(MARKET.collateralToken)
    const repayApprove = decodeFunctionData({
      abi: ERC20_MIN_ABI,
      data: decodeSubCall(queue[2]!).callData
    })
    expect(repayApprove.functionName).toBe('approve')
    expect(getAddress(repayApprove.args[0])).toBe(MORPHO)

    // The redeem output IS the loan token — the standard sweeps already cover it, so no extra skim.
    expect(calls).toHaveLength(3)
  })
})
