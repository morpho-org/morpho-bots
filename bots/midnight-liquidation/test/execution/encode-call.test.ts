import type { Hex } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { describe, expect, it } from 'bun:test'
import { executorAbi } from 'executooor-viem'
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress
} from 'viem'

import type { CollateralParams, Obligation, SwapStep } from '../../src/execution/encode-call'

import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MIDNIGHT = getAddress('0x2222222222222222222222222222222222222222')
const BORROWER = getAddress('0x3333333333333333333333333333333333333333')
const RECIPIENT = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')

const collateralParam: CollateralParams = {
  token: COLLATERAL,
  lltv: 860000000000000000n,
  maxLif: 1036269430051813471n,
  oracle: ORACLE
}
const obligation: Obligation = {
  loanToken: LOAN,
  collateralParams: [collateralParam],
  maturity: 2000n,
  rcfThreshold: 1000000000000000000n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const swapStep: SwapStep = {
  router: ROUTER,
  tokenIn: COLLATERAL,
  tokenOut: LOAN,
  fee: 3000,
  amountOutMinimum: 12345n
}

function encode() {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    midnight: MIDNIGHT,
    obligation,
    collateralIndex: 0,
    seizedAssets: 100n,
    repaidUnits: 0n,
    borrower: BORROWER,
    swapStep,
    recipient: RECIPIENT
  })
}

describe('encodeLiquidationExec', () => {
  it('encodes exec_606BaXt with a liquidate call followed by two token sweeps', () => {
    const top = decodeFunctionData({ abi: executorAbi, data: encode() })
    expect(top.functionName).toBe('exec_606BaXt')
    const calls = top.args[0] as readonly Hex[]
    expect(calls).toHaveLength(3)

    // Call 0: a plain self-gated call to Midnight carrying the liquidate calldata.
    const liquidateCall = decodeFunctionData({ abi: executorAbi, data: calls[0]! })
    if (liquidateCall.functionName !== 'call_g0oyU7o') throw new Error('expected call_g0oyU7o')
    expect(isAddressEqual(liquidateCall.args[0], MIDNIGHT)).toBe(true)

    const liquidate = decodeFunctionData({ abi: MidnightAbi, data: liquidateCall.args[3] })
    if (liquidate.functionName !== 'liquidate') throw new Error('expected liquidate')
    expect(liquidate.args[1]).toBe(0n) // collateralIndex
    expect(liquidate.args[2]).toBe(100n) // seizedAssets
    expect(liquidate.args[3]).toBe(0n) // repaidUnits
    expect(isAddressEqual(liquidate.args[4], BORROWER)).toBe(true)

    // The liquidate `data` is the ABI-encoded swap step.
    const [decodedStep] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'router', type: 'address' },
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'amountOutMinimum', type: 'uint256' }
          ]
        }
      ] as const,
      liquidate.args[5]
    )
    expect(isAddressEqual(decodedStep.router, ROUTER)).toBe(true)
    expect(decodedStep.fee).toBe(3000)
    expect(decodedStep.amountOutMinimum).toBe(12345n)
  })

  it('sweeps the loan token then the collateral token to the recipient', () => {
    const calls = decodeFunctionData({ abi: executorAbi, data: encode() }).args[0] as readonly Hex[]

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
        obligation,
        collateralIndex: 5,
        seizedAssets: 100n,
        repaidUnits: 0n,
        borrower: BORROWER,
        swapStep,
        recipient: RECIPIENT
      })
    ).toThrow(/out of range/)
  })
})
