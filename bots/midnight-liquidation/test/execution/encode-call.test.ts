import type { Swap } from '@repo/swaps'
import type { Hex } from 'viem'

import { MidnightAbi } from '@repo/contracts'
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

import type { CollateralParams, Market } from '../../src/execution/encode-call'

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
const AGG_SPENDER = getAddress('0x9999999999999999999999999999999999999999')
const AGG_TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')

const collateralParam: CollateralParams = {
  token: COLLATERAL,
  lltv: 860000000000000000n,
  liquidationCursor: 250000000000000000n,
  oracle: ORACLE
}
const market: Market = {
  chainId: 8453n,
  midnight: MIDNIGHT,
  loanToken: LOAN,
  collateralParams: [collateralParam],
  maturity: 2000n,
  rcfThreshold: 1000000000000000000n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}

// A balance-bound (Uniswap-style) swap: opaque-to-the-encoder calldata + a 132-byte amountIn offset.
const BALANCE_SWAP: Swap = {
  spender: ROUTER,
  target: ROUTER,
  value: 0n,
  callData: `0x${'be'.repeat(8)}`,
  amountIn: { source: 'balance', offset: 132n },
  expectedAmountOut: 2000n,
  amountOutMinimum: 12345n
}

// A fixed-amount (aggregator-style) swap: opaque calldata committing its own sell amount, distinct
// spender and target — the encoder must NOT splice a placeholder into it.
const FIXED_SWAP: Swap = {
  spender: AGG_SPENDER,
  target: AGG_TARGET,
  value: 0n,
  callData: `0x${'c0ffee'.repeat(4)}`,
  amountIn: { source: 'fixed', value: 100n },
  expectedAmountOut: 2000n,
  amountOutMinimum: 1990n
}

function encode(swap: Swap = BALANCE_SWAP) {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    midnight: MIDNIGHT,
    market,
    collateralIndex: 0,
    seizedAssets: 100n,
    repaidUnits: 0n,
    borrower: BORROWER,
    postMaturityMode: false,
    swap,
    recipient: RECIPIENT
  })
}

function encodeBadDebtRealization() {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    midnight: MIDNIGHT,
    market,
    collateralIndex: 0,
    seizedAssets: 0n,
    repaidUnits: 0n,
    borrower: BORROWER,
    postMaturityMode: true,
    swap: null,
    recipient: RECIPIENT
  })
}

/** Decodes the outer `exec_606BaXt(bytes[])` call list. */
function outerCalls(data: Hex): readonly Hex[] {
  const top = decodeFunctionData({ abi: executorAbi, data })
  if (top.functionName !== 'exec_606BaXt') throw new Error('expected exec_606BaXt')
  return top.args[0] as readonly Hex[]
}

/** Decodes the `liquidate(...)` calldata and the `(bytes[] queue, bytes returnData)` callback blob. */
function decodeLiquidate(data: Hex) {
  const liquidateCall = decodeFunctionData({ abi: executorAbi, data: outerCalls(data)[0]! })
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
    const calls = outerCalls(encode())
    expect(calls).toHaveLength(3)

    const { liquidate } = decodeLiquidate(encode())
    expect(liquidate.args[1]).toBe(0n) // collateralIndex
    expect(liquidate.args[2]).toBe(100n) // seizedAssets
    expect(liquidate.args[3]).toBe(0n) // repaidUnits
    expect(isAddressEqual(liquidate.args[4], BORROWER)).toBe(true)
    expect(liquidate.args[5]).toBe(false) // postMaturityMode
    expect(isAddressEqual(liquidate.args[6], EXECUTOR)).toBe(true) // receiver = the Executor
    expect(isAddressEqual(liquidate.args[7], EXECUTOR)).toBe(true) // callback = the Executor
  })

  it('carries the callback context {sender: MIDNIGHT, dataIndex: 8} on the liquidate call', () => {
    const { context } = decodeLiquidate(encode())
    const packed = BigInt(context)
    // context = dataIndex (high 96 bits) | sender (low 160 bits).
    expect(packed >> 160n).toBe(8n)
    expect(packed & ((1n << 160n) - 1n)).toBe(BigInt(MIDNIGHT))
  })

  it('returns the raw 32-byte CALLBACK_SUCCESS as the callback return blob', () => {
    const { returnData } = decodeLiquidate(encode())
    expect(returnData.toLowerCase()).toBe(CALLBACK_SUCCESS.toLowerCase())
  })

  it('builds a balance-bound queue: zero-first approve to spender, spliced swap, zero-first repay', () => {
    const { queue } = decodeLiquidate(encode(BALANCE_SWAP))
    expect(queue).toHaveLength(5)

    // (1) approve(collateral -> spender, 0) — plain self-call, no placeholder.
    const approveZero = decodeFunctionData({ abi: executorAbi, data: queue[0]! })
    if (approveZero.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(isAddressEqual(approveZero.args[0], COLLATERAL)).toBe(true)
    const approveZeroInner = decodeFunctionData({ abi: erc20Abi, data: approveZero.args[3] })
    if (approveZeroInner.functionName !== 'approve') throw new Error('expected approve')
    expect(isAddressEqual(approveZeroInner.args[0], ROUTER)).toBe(true)
    expect(approveZeroInner.args[1]).toBe(0n)

    // (2) approve(collateral -> spender, <balanceOf>) — placeholder overwrites the amount word (36).
    const approveSeize = decodeFunctionData({ abi: executorAbi, data: queue[1]! })
    if (approveSeize.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(approveSeize.args[4][0]!.offset).toBe(36n)
    expect(isAddressEqual(approveSeize.args[4][0]!.to, COLLATERAL)).toBe(true)

    // (3) the opaque swap call: target + verbatim calldata, amountIn spliced at the venue offset.
    const swap = decodeFunctionData({ abi: executorAbi, data: queue[2]! })
    if (swap.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(swap.args[0], ROUTER)).toBe(true)
    expect(swap.args[3]).toBe(BALANCE_SWAP.callData)
    expect(swap.args[4][0]!.offset).toBe(132n)
    expect(isAddressEqual(swap.args[4][0]!.to, COLLATERAL)).toBe(true)

    // (4) approve(loan -> MIDNIGHT, 0) — zero-first, plain self-call.
    const repayApproveZero = decodeFunctionData({ abi: executorAbi, data: queue[3]! })
    if (repayApproveZero.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(isAddressEqual(repayApproveZero.args[0], LOAN)).toBe(true)

    // (5) approve(loan -> MIDNIGHT, <balanceOf>) — placeholder overwrites the amount word (36).
    const repayApprove = decodeFunctionData({ abi: executorAbi, data: queue[4]! })
    if (repayApprove.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(repayApprove.args[0], LOAN)).toBe(true)
    expect(repayApprove.args[4][0]!.offset).toBe(36n)
  })

  it('builds a fixed-amount (aggregator) queue: approve the spender, run opaque calldata with NO splice', () => {
    const { queue } = decodeLiquidate(encode(FIXED_SWAP))
    expect(queue).toHaveLength(5)

    // (1)/(2) collateral approvals target the aggregator's spender, not its call target.
    const approveZero = decodeFunctionData({ abi: executorAbi, data: queue[0]! })
    if (approveZero.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    const approveZeroInner = decodeFunctionData({ abi: erc20Abi, data: approveZero.args[3] })
    if (approveZeroInner.functionName !== 'approve') throw new Error('expected approve')
    expect(isAddressEqual(approveZeroInner.args[0], AGG_SPENDER)).toBe(true)

    // (3) the swap runs the route-bound calldata verbatim, against `target`, with NO placeholder —
    //     splicing a live balance into aggregator calldata would corrupt the committed sell amount.
    const swap = decodeFunctionData({ abi: executorAbi, data: queue[2]! })
    if (swap.functionName !== 'call_g0oyU7o')
      throw new Error('expected plain call (no placeholder)')
    expect(isAddressEqual(swap.args[0], AGG_TARGET)).toBe(true)
    expect(swap.args[3]).toBe(FIXED_SWAP.callData)
  })

  it('sweeps the loan token then the collateral token to the recipient', () => {
    const calls = outerCalls(encode())

    const loanSweep = decodeFunctionData({ abi: executorAbi, data: calls[1]! })
    if (loanSweep.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(loanSweep.args[0], LOAN)).toBe(true)

    const collateralSweep = decodeFunctionData({ abi: executorAbi, data: calls[2]! })
    if (collateralSweep.functionName !== 'callWithPlaceholders4845164670')
      throw new Error('expected placeholder call')
    expect(isAddressEqual(collateralSweep.args[0], COLLATERAL)).toBe(true)
  })

  it('encodes fully bad-debt realization without callback, swap, or sweeps', () => {
    const calls = outerCalls(encodeBadDebtRealization())
    expect(calls).toHaveLength(1)

    const liquidateCall = decodeFunctionData({ abi: executorAbi, data: calls[0]! })
    if (liquidateCall.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(BigInt(liquidateCall.args[2])).toBe(0n) // no fallback context needed

    const liquidate = decodeFunctionData({ abi: MidnightAbi, data: liquidateCall.args[3] })
    if (liquidate.functionName !== 'liquidate') throw new Error('expected liquidate')
    expect(liquidate.args[2]).toBe(0n) // seizedAssets
    expect(liquidate.args[3]).toBe(0n) // repaidUnits
    expect(isAddressEqual(liquidate.args[6], RECIPIENT)).toBe(true)
    expect(isAddressEqual(liquidate.args[7], zeroAddress)).toBe(true)
    expect(liquidate.args[8]).toBe('0x')
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
        swap: BALANCE_SWAP,
        recipient: RECIPIENT
      })
    ).toThrow(/out of range/)
  })

  it('throws when a non-zero liquidation has no swap', () => {
    expect(() =>
      encodeLiquidationExec({
        executor: EXECUTOR,
        midnight: MIDNIGHT,
        market,
        collateralIndex: 0,
        seizedAssets: 100n,
        repaidUnits: 0n,
        borrower: BORROWER,
        postMaturityMode: false,
        swap: null,
        recipient: RECIPIENT
      })
    ).toThrow(/swap is required/)
  })
})

// Guards against silent TS/ABI struct drift: the Market/CollateralParams shape is hand-maintained in
// four places (vendored IMidnight.sol, the lens inline Solidity, this TS type, and offers.ts tuples).
// If the ABI's `liquidate` market arg and the TS `Market` fixture fall out of field-order sync, the
// encoding is malformed — so pin them to each other here.
describe('Market ABI/type drift guard', () => {
  type AbiParam = { name: string; components?: readonly AbiParam[] }
  const abi = MidnightAbi as readonly {
    type: string
    name?: string
    inputs?: readonly AbiParam[]
  }[]

  it('TS Market/CollateralParams field order matches MidnightAbi.liquidate', () => {
    const liquidate = abi.find(e => e.type === 'function' && e.name === 'liquidate')
    const marketArg = liquidate?.inputs?.[0]
    if (!marketArg?.components) throw new Error('liquidate market arg not found in MidnightAbi')
    expect(Object.keys(market)).toEqual(marketArg.components.map(c => c.name))

    const cpArg = marketArg.components.find(c => c.name === 'collateralParams')
    if (!cpArg?.components) throw new Error('collateralParams not found in MidnightAbi')
    expect(Object.keys(collateralParam)).toEqual(cpArg.components.map(c => c.name))
  })
})
