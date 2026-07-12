import { describe, expect, it } from 'bun:test'

import type { SignerErrorCode } from '../src/protocol'

import {
  fromWireTx,
  okResponse,
  parseRequestLine,
  ProtocolError,
  serializeResponse,
  SIGNER_PROTOCOL_VERSION,
  toWireTx
} from '../src/protocol'

const VALID_WIRE = {
  type: 'eip1559',
  chainId: 8453,
  to: `0x${'11'.repeat(20)}`,
  data: '0x00000001',
  value: '0',
  nonce: 3,
  gas: '21000',
  maxFeePerGas: '1000000000',
  maxPriorityFeePerGas: '1000000'
} as const

function caught(fn: () => unknown): ProtocolError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ProtocolError) return error
    throw error
  }
  throw new Error('expected ProtocolError')
}

function expectCode(fn: () => unknown, code: SignerErrorCode) {
  expect(caught(fn).code).toBe(code)
}

describe('parseRequestLine', () => {
  it('parses the two uncorrelated request shapes', () => {
    expect(parseRequestLine('{"v":3,"method":"address"}')).toEqual({
      v: 3,
      method: 'address'
    })
    const request = parseRequestLine(
      JSON.stringify({ v: 3, method: 'signTransaction', transaction: VALID_WIRE })
    )
    expect(request).toEqual({ v: 3, method: 'signTransaction', transaction: VALID_WIRE })
  })

  it('rejects invalid JSON, methods, missing tx, and version mismatch', () => {
    expectCode(() => parseRequestLine('nope'), 'bad_request')
    expectCode(() => parseRequestLine('{"v":3,"method":"ping"}'), 'bad_request')
    expectCode(() => parseRequestLine('{"v":3,"method":"signTransaction"}'), 'bad_request')
    expectCode(() => parseRequestLine('{"v":2,"method":"address"}'), 'unsupported_version')
  })
})

describe('toWireTx', () => {
  it('normalizes a complete EIP-1559 transaction', () => {
    expect(toWireTx(VALID_WIRE)).toMatchObject({
      chainId: 8453,
      to: '0x1111111111111111111111111111111111111111',
      gas: '21000'
    })
  })

  it('strictly rejects malformed or incomplete signing payloads', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, to: null }), 'bad_request')
    expectCode(() => toWireTx({ ...VALID_WIRE, data: 'zz' }), 'bad_request')
    expectCode(() => toWireTx({ ...VALID_WIRE, gas: '0' }), 'bad_request')
    expectCode(() => toWireTx({ ...VALID_WIRE, maxFeePerGas: '0x10' }), 'bad_request')
    expectCode(() => toWireTx({ ...VALID_WIRE, maxPriorityFeePerGas: '1000000001' }), 'bad_request')
    const { nonce: _nonce, ...missingNonce } = VALID_WIRE
    expectCode(() => toWireTx(missingNonce), 'bad_request')
  })
})

it('converts wire decimals to serializable bigints', () => {
  expect(fromWireTx(toWireTx(VALID_WIRE))).toEqual({
    ...VALID_WIRE,
    value: 0n,
    gas: 21000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000n
  })
})

it('serializes a response without a correlation id', () => {
  const line = serializeResponse(okResponse({ address: VALID_WIRE.to }))
  expect(JSON.parse(line)).toEqual({
    v: SIGNER_PROTOCOL_VERSION,
    ok: true,
    result: { address: VALID_WIRE.to }
  })
})
