import type { Hex } from 'viem'

import { decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { SwapStep } from '../../src/types'

import {
  approvePair,
  intermediateTokens,
  skimCall,
  stepCalls,
  sweepCalls
} from '../../src/execution/executor-calls'

const EXECUTOR = getAddress('0x1234567890123456789012345678901234567890')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000ee01')
const TOKEN_IN = getAddress('0x4200000000000000000000000000000000000006')
const TOKEN_OUT = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481')

// `approve(spender, amount)` / `transfer(recipient, amount)`: the amount word sits at byte offset
// 4 (selector) + 32 (the address word).
const ERC20_AMOUNT_OFFSET = 36n

// Matches executooor's `struct Placeholder` exactly (offset/length/resOffset are uint64).
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

// Minimal ERC20 subset (approve + transfer) so args[0] decodes to a plain address.
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

function decodeSubCall(blob: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: SUBCALL_ABI, data: blob })
  return { functionName, target: getAddress(args[0]), callData: args[3] }
}

function placeholdersOf(blob: Hex) {
  const { args } = decodeFunctionData({ abi: SUBCALL_ABI, data: blob })
  return args[4]
}

function step(overrides: Partial<SwapStep> = {}): SwapStep {
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    target: ROUTER,
    value: 0n,
    callData: '0xdeadbeef',
    amountIn: { source: 'balance', offset: 132n },
    approvalSpender: ROUTER,
    ...overrides
  }
}

describe('skimCall', () => {
  it('transfers to the recipient with the amount spliced from balanceOf at offset 36', () => {
    const call = skimCall(TOKEN_IN, RECIPIENT, EXECUTOR)
    const decoded = decodeSubCall(call)
    expect(decoded.functionName).toBe('callWithPlaceholders4845164670')
    expect(decoded.target).toBe(TOKEN_IN)

    const transfer = decodeFunctionData({ abi: ERC20_MIN_ABI, data: decoded.callData })
    expect(transfer.functionName).toBe('transfer')
    expect(getAddress(transfer.args[0])).toBe(RECIPIENT)

    const placeholders = placeholdersOf(call)!
    expect(placeholders).toHaveLength(1)
    expect(getAddress(placeholders[0]!.to)).toBe(TOKEN_IN)
    expect(placeholders[0]!.offset).toBe(ERC20_AMOUNT_OFFSET)
  })
})

describe('approvePair', () => {
  it('zeroes then balance-approves the spender (USDT-safe pair)', () => {
    const [zero, set] = approvePair(TOKEN_IN, ROUTER, EXECUTOR)

    const zeroCall = decodeSubCall(zero!)
    expect(zeroCall.functionName).toBe('call_g0oyU7o') // no placeholder — a fixed 0
    const zeroApprove = decodeFunctionData({ abi: ERC20_MIN_ABI, data: zeroCall.callData })
    expect(zeroApprove.functionName).toBe('approve')
    expect(getAddress(zeroApprove.args[0])).toBe(ROUTER)
    expect(zeroApprove.args[1]).toBe(0n)

    const setCall = decodeSubCall(set!)
    expect(setCall.functionName).toBe('callWithPlaceholders4845164670') // spliced to live balance
    expect(placeholdersOf(set!)![0]!.offset).toBe(ERC20_AMOUNT_OFFSET)
  })
})

describe('stepCalls', () => {
  it('prepends the approve pair and splices a balance-source step', () => {
    const calls = stepCalls(step(), EXECUTOR)
    expect(calls).toHaveLength(3) // approve(0), approve(bal), swap
    expect(decodeSubCall(calls[0]!).functionName).toBe('call_g0oyU7o')
    expect(decodeSubCall(calls[1]!).functionName).toBe('callWithPlaceholders4845164670')
    // The swap is spliced with the live tokenIn balance at the step-supplied offset.
    const swap = decodeSubCall(calls[2]!)
    expect(swap.functionName).toBe('callWithPlaceholders4845164670')
    expect(swap.target).toBe(ROUTER)
    expect(placeholdersOf(calls[2]!)![0]!.offset).toBe(132n)
  })

  it('emits a plain (unspliced) call for a fixed-source step', () => {
    const calls = stepCalls(step({ amountIn: { source: 'fixed', value: 5n } }), EXECUTOR)
    expect(calls).toHaveLength(3)
    expect(decodeSubCall(calls[2]!).functionName).toBe('call_g0oyU7o')
  })

  it('omits the approve pair when the step has no approvalSpender (self-burning redeem)', () => {
    const calls = stepCalls(step({ approvalSpender: undefined }), EXECUTOR)
    expect(calls).toHaveLength(1) // just the step call, no approve pair
    expect(decodeSubCall(calls[0]!).functionName).toBe('callWithPlaceholders4845164670')
  })
})

describe('intermediateTokens', () => {
  it('returns each step output that is not excluded, deduped, preserving order', () => {
    const mid1 = getAddress('0x1111111111111111111111111111111111111111')
    const mid2 = getAddress('0x2222222222222222222222222222222222222222')
    const steps = [
      step({ tokenOut: mid1 }),
      step({ tokenOut: mid1 }), // duplicate → collapsed
      step({ tokenOut: mid2 }),
      step({ tokenOut: TOKEN_OUT }) // excluded
    ]
    expect(intermediateTokens(steps, [TOKEN_OUT, TOKEN_IN])).toEqual([mid1, mid2])
  })

  it('returns [] when every output is excluded', () => {
    expect(intermediateTokens([step({ tokenOut: TOKEN_OUT })], [TOKEN_OUT])).toEqual([])
  })
})

describe('sweepCalls', () => {
  const sweptTokens = (calls: Hex[]) => calls.map(call => decodeSubCall(call).target)

  it('sweeps the loan token, then the collateral token, then the intermediates', () => {
    const mid = getAddress('0x1111111111111111111111111111111111111111')
    const calls = sweepCalls({
      loanToken: TOKEN_OUT,
      collateralToken: TOKEN_IN,
      steps: [step({ tokenOut: mid }), step({ tokenOut: TOKEN_OUT })],
      recipient: RECIPIENT,
      executor: EXECUTOR
    })
    expect(sweptTokens(calls)).toEqual([TOKEN_OUT, TOKEN_IN, mid])
  })

  it('emits ONE sweep when the collateral token IS the loan token', () => {
    // Midnight's loan-as-collateral slots. A second sweep would transfer zero, which some ERC-20s
    // revert on — so this is a correctness guard, not just a gas saving.
    const calls = sweepCalls({
      loanToken: TOKEN_OUT,
      collateralToken: TOKEN_OUT,
      steps: [],
      recipient: RECIPIENT,
      executor: EXECUTOR
    })
    expect(sweptTokens(calls)).toEqual([TOKEN_OUT])
  })

  it('still excludes a coincident market token from the intermediates', () => {
    // The deduped market list is what gates `intermediateTokens`, so a step landing on the shared
    // token cannot smuggle it back in as an "intermediate" and re-create the duplicate sweep.
    const calls = sweepCalls({
      loanToken: TOKEN_OUT,
      collateralToken: TOKEN_OUT,
      steps: [step({ tokenOut: TOKEN_OUT })],
      recipient: RECIPIENT,
      executor: EXECUTOR
    })
    expect(sweptTokens(calls)).toEqual([TOKEN_OUT])
  })

  it('sweeps to the recipient with the amount spliced from the live balance', () => {
    const [call] = sweepCalls({
      loanToken: TOKEN_OUT,
      collateralToken: TOKEN_OUT,
      steps: [],
      recipient: RECIPIENT,
      executor: EXECUTOR
    })
    // Same shape skimCall produces — sweepCalls composes it rather than re-encoding a transfer.
    expect(call).toBe(skimCall(TOKEN_OUT, RECIPIENT, EXECUTOR))
  })
})
