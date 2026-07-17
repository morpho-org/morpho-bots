import { describe, expect, it } from 'bun:test'
import { BaseError, encodeErrorResult, ExecutionRevertedError } from 'viem'

import { abiRevertDecoder, isExecutionRevert, revertReason, TxSendError } from '../src/tx-error'

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
function revertError(data: `0x${string}`): BaseError {
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

  it('unwraps a TxSendError and stringifies non-viem errors', () => {
    const data = encodeErrorResult({ abi: SOLIDITY_ERRORS, errorName: 'Error', args: ['inner'] })
    expect(revertReason(new TxSendError(revertError(data), 7))).toBe('inner')
    expect(revertReason(new Error('plain failure'))).toBe('plain failure')
    expect(revertReason('string failure')).toBe('string failure')
  })
})

describe('isExecutionRevert', () => {
  it('recognizes execution reverts, including wrapped in TxSendError', () => {
    const revert = new ExecutionRevertedError({})
    expect(isExecutionRevert(revert)).toBe(true)
    expect(isExecutionRevert(new TxSendError(revert, 7))).toBe(true)
  })

  it('rejects transient/non-viem errors', () => {
    expect(isExecutionRevert(new Error('connection reset'))).toBe(false)
    expect(isExecutionRevert(new BaseError('http timeout'))).toBe(false)
  })
})
