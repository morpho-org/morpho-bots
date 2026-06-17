import type { Hex } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { describe, expect, it } from 'bun:test'
import { executorAbi } from 'executooor-viem'
import {
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  zeroAddress
} from 'viem'

import type { CollateralParams, Market, SwapStep } from '../../src/execution/encode-call'

import { CALLBACK_SUCCESS } from '../../src/constants'
import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MIDNIGHT = getAddress('0x2222222222222222222222222222222222222222')
const BORROWER = getAddress('0x3333333333333333333333333333333333333333')
const RECIPIENT = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')

// Local copy of the SwapRouter02 `exactInputSingle` shape, for decoding the swap sub-call.
const EXACT_INPUT_SINGLE_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' }
        ]
      }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const

const collateralParam: CollateralParams = {
  token: COLLATERAL,
  lltv: 860000000000000000n,
  maxLif: 1036269430051813471n,
  oracle: ORACLE
}
const market: Market = {
  loanToken: LOAN,
  collateralParams: [collateralParam],
  maturity: 2000n,
  rcfThreshold: 1000000000000000000n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const swapStep: SwapStep = {
  router: ROUTER,
  fee: 3000,
  amountOutMinimum: 12345n
}

function encode() {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    midnight: MIDNIGHT,
    market,
    collateralIndex: 0,
    seizedAssets: 100n,
    repaidUnits: 0n,
    borrower: BORROWER,
    postMaturityMode: false,
    swapStep,
    recipient: RECIPIENT
  })
}

/** Decodes the outer `exec_606BaXt(bytes[])` call list. */
function outerCalls(): readonly Hex[] {
  const top = decodeFunctionData({ abi: executorAbi, data: encode() })
  if (top.functionName !== 'exec_606BaXt') throw new Error('expected exec_606BaXt')
  return top.args[0] as readonly Hex[]
}

/** Decodes the `liquidate(...)` calldata and the `(bytes[] queue, bytes returnData)` callback blob. */
function decodeLiquidate() {
  const liquidateCall = decodeFunctionData({ abi: executorAbi, data: outerCalls()[0]! })
  if (liquidateCall.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
  const liquidate = decodeFunctionData({ abi: MidnightAbi, data: liquidateCall.args[3] })
  if (liquidate.functionName !== 'liquidate') throw new Error('expected liquidate')
  const [queue, returnData] = decodeAbiParameters(
    [{ type: 'bytes[]' }, { type: 'bytes' }] as const,
    liquidate.args[8]
  )
  return { context: liquidateCall.args[2], liquidate, queue, returnData }
}

describe('encodeLiquidationExec', () => {
  it('encodes exec_606BaXt with a liquidate call followed by two token sweeps', () => {
    const calls = outerCalls()
    expect(calls).toHaveLength(3)

    const { liquidate } = decodeLiquidate()
    expect(liquidate.args[1]).toBe(0n) // collateralIndex
    expect(liquidate.args[2]).toBe(100n) // seizedAssets
    expect(liquidate.args[3]).toBe(0n) // repaidUnits
    expect(isAddressEqual(liquidate.args[4], BORROWER)).toBe(true)
    expect(liquidate.args[5]).toBe(false) // postMaturityMode
    expect(isAddressEqual(liquidate.args[6], EXECUTOR)).toBe(true) // receiver = the Executor
    expect(isAddressEqual(liquidate.args[7], EXECUTOR)).toBe(true) // callback = the Executor
  })

  it('carries the callback context {sender: MIDNIGHT, dataIndex: 8} on the liquidate call', () => {
    const { context } = decodeLiquidate()
    const packed = BigInt(context)
    // context = dataIndex (high 96 bits) | sender (low 160 bits).
    expect(packed >> 160n).toBe(8n)
    expect(packed & ((1n << 160n) - 1n)).toBe(BigInt(MIDNIGHT))
  })

  it('returns the raw 32-byte CALLBACK_SUCCESS as the callback return blob', () => {
    const { returnData } = decodeLiquidate()
    expect(returnData.toLowerCase()).toBe(CALLBACK_SUCCESS.toLowerCase())
  })

  it('builds the callback queue: zero-first collateral approve, swap, zero-first repay approval', () => {
    const { queue } = decodeLiquidate()
    expect(queue).toHaveLength(5)

    // (1) approve(collateral -> router, 0) — plain self-call, no placeholder.
    const approveZero = decodeFunctionData({ abi: executorAbi, data: queue[0]! })
    if (approveZero.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(isAddressEqual(approveZero.args[0], COLLATERAL)).toBe(true)
    const approveZeroInner = decodeFunctionData({ abi: erc20Abi, data: approveZero.args[3] })
    if (approveZeroInner.functionName !== 'approve') throw new Error('expected approve')
    expect(isAddressEqual(approveZeroInner.args[0], ROUTER)).toBe(true)
    expect(approveZeroInner.args[1]).toBe(0n)

    // (2) approve(collateral -> router, <balanceOf>) — placeholder overwrites the amount word (36).
    const approveSeize = decodeFunctionData({ abi: executorAbi, data: queue[1]! })
    if (approveSeize.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(approveSeize.args[0], COLLATERAL)).toBe(true)
    expect(approveSeize.args[4][0]!.offset).toBe(36n)
    expect(isAddressEqual(approveSeize.args[4][0]!.to, COLLATERAL)).toBe(true)

    // (3) exactInputSingle(collateral -> loan, recipient = Executor) — amountIn placeholder (132).
    const swap = decodeFunctionData({ abi: executorAbi, data: queue[2]! })
    if (swap.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(swap.args[0], ROUTER)).toBe(true)
    expect(swap.args[4][0]!.offset).toBe(132n)
    expect(isAddressEqual(swap.args[4][0]!.to, COLLATERAL)).toBe(true)
    const swapInner = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swap.args[3] })
    if (swapInner.functionName !== 'exactInputSingle') throw new Error('expected exactInputSingle')
    expect(isAddressEqual(swapInner.args[0].tokenIn, COLLATERAL)).toBe(true)
    expect(isAddressEqual(swapInner.args[0].tokenOut, LOAN)).toBe(true)
    expect(swapInner.args[0].fee).toBe(3000)
    expect(isAddressEqual(swapInner.args[0].recipient, EXECUTOR)).toBe(true)
    expect(swapInner.args[0].amountOutMinimum).toBe(12345n)

    // (4) approve(loan -> MIDNIGHT, 0) — zero-first, plain self-call.
    const repayApproveZero = decodeFunctionData({ abi: executorAbi, data: queue[3]! })
    if (repayApproveZero.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(isAddressEqual(repayApproveZero.args[0], LOAN)).toBe(true)
    const repayZeroInner = decodeFunctionData({ abi: erc20Abi, data: repayApproveZero.args[3] })
    if (repayZeroInner.functionName !== 'approve') throw new Error('expected approve')
    expect(isAddressEqual(repayZeroInner.args[0], MIDNIGHT)).toBe(true)
    expect(repayZeroInner.args[1]).toBe(0n)

    // (5) approve(loan -> MIDNIGHT, <balanceOf>) — placeholder overwrites the amount word (36).
    const repayApprove = decodeFunctionData({ abi: executorAbi, data: queue[4]! })
    if (repayApprove.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(repayApprove.args[0], LOAN)).toBe(true)
    expect(repayApprove.args[4][0]!.offset).toBe(36n)
    expect(isAddressEqual(repayApprove.args[4][0]!.to, LOAN)).toBe(true)
    const repayInner = decodeFunctionData({ abi: erc20Abi, data: repayApprove.args[3] })
    if (repayInner.functionName !== 'approve') throw new Error('expected approve')
    expect(isAddressEqual(repayInner.args[0], MIDNIGHT)).toBe(true)
  })

  it('sweeps the loan token then the collateral token to the recipient', () => {
    const calls = outerCalls()

    const loanSweep = decodeFunctionData({ abi: executorAbi, data: calls[1]! })
    if (loanSweep.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(loanSweep.args[0], LOAN)).toBe(true)

    const collateralSweep = decodeFunctionData({ abi: executorAbi, data: calls[2]! })
    if (collateralSweep.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(collateralSweep.args[0], COLLATERAL)).toBe(true)
  })

  it('throws when the collateral index is out of range', () => {
    expect(() =>
      encodeLiquidationExec({
        executor: EXECUTOR,
        midnight: MIDNIGHT,
        market,
        collateralIndex: 5,
        seizedAssets: 100n,
        repaidUnits: 0n,
        borrower: BORROWER,
        postMaturityMode: false,
        swapStep,
        recipient: RECIPIENT
      })
    ).toThrow(/out of range/)
  })
})
