import type { Address } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { describe, expect, it } from 'bun:test'
import {
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddressEqual
} from 'viem'
import { base } from 'viem/chains'

import type { Obligation } from '../../src/execution/encode-call'
import type { LiquidationPlan } from '../../src/sizing/plan'

import { classifyRevert, simulateLiquidate } from '../../src/execution/simulate'

// Solady SafeTransferLib.TransferFromFailed() — the unfunded sentinel.
const TRANSFER_FROM_FAILED = '0x7939f424'

describe('classifyRevert', () => {
  it('maps the TransferFromFailed selector to unfunded (plan valid, just unfunded)', () => {
    // An undecodable custom-error selector: viem sets `.raw`/`.signature` to the 4-byte selector.
    const error = new ContractFunctionRevertedError({
      abi: [],
      data: TRANSFER_FROM_FAILED,
      functionName: 'liquidate'
    })
    expect(classifyRevert(error)).toEqual({ status: 'unfunded' })
  })

  it('maps a Midnight string revert to revert with its reason (signals a sizing bug)', () => {
    const error = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'liquidate',
      message: 'position is not liquidatable'
    })
    expect(classifyRevert(error)).toEqual({
      status: 'revert',
      reason: 'position is not liquidatable'
    })
  })

  it('falls back to the error message for a non-contract error', () => {
    expect(classifyRevert(new Error('rpc timeout'))).toEqual({
      status: 'revert',
      reason: 'rpc timeout'
    })
  })
})

const MIDNIGHT = getAddress('0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854')
const EXECUTOOOR = getAddress('0x2222222222222222222222222222222222222222')
const BORROWER = getAddress('0x1111111111111111111111111111111111111111')
const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const

const OBLIGATION: Obligation = {
  loanToken: TOKEN,
  collateralParams: [
    { token: TOKEN, lltv: 860000000000000000n, maxLif: 1100000000000000000n, oracle: ORACLE }
  ],
  maturity: 2000n,
  rcfThreshold: 1n,
  enterGate: ZERO,
  liquidatorGate: ZERO
}
const PLAN: LiquidationPlan = {
  collateralIndex: 1,
  seizedAssets: 1234n,
  repaidUnits: 0n,
  postMaturityMode: false
}

describe('simulateLiquidate', () => {
  it('forwards the liquidate call (args order, executor account, empty data) and returns ok', async () => {
    let from: Address | undefined
    let data: `0x${string}` | undefined
    const client = createPublicClient({
      chain: base,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_chainId') return `0x${base.id.toString(16)}`
          if (method === 'eth_call') {
            const call = (params as [{ from?: Address; data?: `0x${string}` }])[0]
            from = call.from
            data = call.data
            // liquidate returns (uint256, uint256) — hand back a decodable success result.
            return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 0n])
          }
          throw new Error(`unexpected RPC method ${method}`)
        }
      })
    })

    const result = await simulateLiquidate(client, {
      midnight: MIDNIGHT,
      executooor: EXECUTOOOR,
      obligation: OBLIGATION,
      borrower: BORROWER,
      plan: PLAN
    })

    expect(result).toEqual({ status: 'ok' })
    expect(from && isAddressEqual(from, EXECUTOOOR)).toBe(true)
    const decoded = decodeFunctionData({ abi: MidnightAbi, data: data! })
    expect(decoded.functionName).toBe('liquidate')
    // args: (obligation, collateralIndex, seizedAssets, repaidUnits, borrower, data)
    expect(decoded.args[1]).toBe(BigInt(PLAN.collateralIndex))
    expect(decoded.args[2]).toBe(PLAN.seizedAssets)
    expect(decoded.args[3]).toBe(PLAN.repaidUnits)
    expect(isAddressEqual(decoded.args[4] as Address, BORROWER)).toBe(true)
    expect(decoded.args[5]).toBe('0x')
  })
})
