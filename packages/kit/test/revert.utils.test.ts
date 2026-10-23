import type { Hex } from 'viem'

import {
  BaseError,
  encodeErrorResult,
  ExecutionRevertedError,
  HttpRequestError,
  RpcRequestError
} from 'viem'
import { describe, expect, it } from 'vitest'

import { abiRevertDecoder, isCallRevert, revertReason } from '../src/revert.utils'

const SOLIDITY_ERRORS = [
  { type: 'error', name: 'Error', inputs: [{ type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ type: 'uint256' }] }
] as const

const CUSTOM_ABI = [
  { type: 'error', name: 'NotBorrower', inputs: [{ name: 'who', type: 'address' }] },
  { type: 'error', name: 'Halted', inputs: [] }
] as const

const BORROWER = '0x1111111111111111111111111111111111111111'

// A viem-style error chain whose cause carries an ABI-encoded revert payload, the shape
// `revertReason` walks for.
function revertError(data: Hex): BaseError {
  return new BaseError('execution reverted', {
    cause: Object.assign(new Error('execution reverted'), { data })
  })
}

describe('revertReason standard (default) decoding', () => {
  it('decodes Error(string) to the bare string and Panic(uint256) to Panic(code)', () => {
    const errorData = encodeErrorResult({
      abi: SOLIDITY_ERRORS,
      errorName: 'Error',
      args: ['healthy position']
    })
    expect(revertReason(revertError(errorData))).toBe('healthy position')

    const panicData = encodeErrorResult({ abi: SOLIDITY_ERRORS, errorName: 'Panic', args: [17n] })
    expect(revertReason(revertError(panicData))).toBe('Panic(17)')
  })
})

describe('abiRevertDecoder', () => {
  const decode = abiRevertDecoder(CUSTOM_ABI)

  it('formats a custom error as Name(args) and an argless one as its bare name', () => {
    const withArgs = encodeErrorResult({
      abi: CUSTOM_ABI,
      errorName: 'NotBorrower',
      args: [BORROWER]
    })
    expect(decode(withArgs)).toBe(`NotBorrower(${BORROWER})`)

    const argless = encodeErrorResult({ abi: CUSTOM_ABI, errorName: 'Halted', args: [] })
    expect(decode(argless)).toBe('Halted')
  })

  it('still decodes the standard Error(string) selector (viem special-cases it)', () => {
    const errorData = encodeErrorResult({
      abi: SOLIDITY_ERRORS,
      errorName: 'Error',
      args: ['nope']
    })
    // Formatted like any other decoded error — matching what the bots' ABI decode always did.
    expect(decode(errorData)).toBe('Error(nope)')
  })
})

describe('revertReason', () => {
  it('decodes standard reverts by default', () => {
    const data = encodeErrorResult({
      abi: SOLIDITY_ERRORS,
      errorName: 'Error',
      args: ['market not created']
    })
    expect(revertReason(revertError(data))).toBe('market not created')
  })

  it('uses an injected custom decoder', () => {
    const data = encodeErrorResult({ abi: CUSTOM_ABI, errorName: 'NotBorrower', args: [BORROWER] })
    expect(revertReason(revertError(data), abiRevertDecoder(CUSTOM_ABI))).toBe(
      `NotBorrower(${BORROWER})`
    )
  })

  it('falls through to the short message when the decoder does not know the selector', () => {
    const data = encodeErrorResult({ abi: CUSTOM_ABI, errorName: 'Halted', args: [] })
    // The default (standard-only) decoder throws on the custom selector → shortMessage.
    expect(revertReason(revertError(data))).toBe('execution reverted')
  })

  it('stringifies non-viem errors', () => {
    expect(revertReason(new Error('plain failure'))).toBe('plain failure')
    expect(revertReason('string failure')).toBe('string failure')
  })
})

describe('isCallRevert', () => {
  it('recognizes execution reverts', () => {
    expect(isCallRevert(new ExecutionRevertedError({}))).toBe(true)
  })

  it('rejects transient/non-viem errors', () => {
    expect(isCallRevert(new Error('connection reset'))).toBe(false)
    expect(isCallRevert(new BaseError('http timeout'))).toBe(false)
  })
})

describe('isCallRevert', () => {
  const URL = 'http://127.0.0.1:1'
  const rpcAnswer = (code: number, message: string) =>
    new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: URL })

  it('reads a raw eth_call answer that says the call reverted as a revert', () => {
    expect(isCallRevert(rpcAnswer(3, 'execution reverted: NotLiquidatable'))).toBe(true)
    expect(
      isCallRevert(new BaseError('call failed', { cause: rpcAnswer(-32000, 'execution reverted') }))
    ).toBe(true)
    expect(isCallRevert(new ExecutionRevertedError({}))).toBe(true)
  })

  it('never reads a failed read as a revert', () => {
    expect(isCallRevert(rpcAnswer(-32000, 'header not found'))).toBe(false)
    expect(isCallRevert(rpcAnswer(-32603, 'internal error'))).toBe(false)
    expect(isCallRevert(new HttpRequestError({ url: URL, status: 502 }))).toBe(false)
    expect(isCallRevert(new Error('execution reverted'))).toBe(false)
  })
})
