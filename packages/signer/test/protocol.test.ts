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
  data: '0x',
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
  throw new Error('expected a ProtocolError to be thrown')
}

function expectCode(fn: () => unknown, code: SignerErrorCode) {
  expect(caught(fn).code).toBe(code)
}

describe('parseRequestLine', () => {
  it('parses a valid request line and leaves params opaque', () => {
    const line = JSON.stringify({ v: 1, id: 'abc', method: 'signTransaction', params: VALID_WIRE })
    const req = parseRequestLine(line)
    expect(req).toEqual({ v: 1, id: 'abc', method: 'signTransaction', params: VALID_WIRE })
  })

  it('accepts ping/address without params', () => {
    expect(parseRequestLine('{"v":1,"id":"1","method":"address"}').method).toBe('address')
    expect(parseRequestLine('{"v":1,"id":"1","method":"ping"}').method).toBe('ping')
  })

  it('rejects non-JSON as bad_request', () => {
    expectCode(() => parseRequestLine('not json'), 'bad_request')
  })

  it('rejects an unknown method as bad_request', () => {
    expectCode(() => parseRequestLine('{"v":1,"id":"1","method":"nuke"}'), 'bad_request')
  })

  it('rejects a missing/empty id as bad_request', () => {
    expectCode(() => parseRequestLine('{"v":1,"id":"","method":"ping"}'), 'bad_request')
  })

  it('maps a version mismatch to unsupported_version and echoes the id', () => {
    const error = caught(() => parseRequestLine('{"v":2,"id":"xyz","method":"ping"}'))
    expect(error.code).toBe('unsupported_version')
    expect(error.id).toBe('xyz')
  })
})

describe('toWireTx', () => {
  it('normalizes a valid params object (checksums `to`)', () => {
    const wire = toWireTx(VALID_WIRE)
    expect(wire.chainId).toBe(8453)
    expect(wire.to).toBe('0x1111111111111111111111111111111111111111')
    expect(wire.gas).toBe('21000')
  })

  it('tolerates unknown extra fields', () => {
    expect(() => toWireTx({ ...VALID_WIRE, surprise: 'ignored' })).not.toThrow()
  })

  it('rejects a bad address as bad_request', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, to: '0xnothex' }), 'bad_request')
  })

  it('rejects a non-hex data field as bad_request', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, data: 'zz' }), 'bad_request')
  })

  it('rejects a non-decimal bigint field as bad_request', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, maxFeePerGas: '0x10' }), 'bad_request')
  })

  it('rejects a missing field as bad_request', () => {
    const { gas: _gas, ...withoutGas } = VALID_WIRE
    expectCode(() => toWireTx(withoutGas), 'bad_request')
  })

  it('rejects gas of "0" as bad_request (viem would sign a gas-less tx)', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, gas: '0' }), 'bad_request')
  })

  it('refuses a deployment (null `to`) as bad_request', () => {
    expectCode(() => toWireTx({ ...VALID_WIRE, to: null }), 'bad_request')
  })
})

describe('fromWireTx', () => {
  it('round-trips decimal strings back to bigints', () => {
    const tx = fromWireTx(toWireTx(VALID_WIRE))
    expect(tx).toEqual({
      type: 'eip1559',
      chainId: 8453,
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      value: 0n,
      nonce: 3,
      gas: 21000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n
    })
  })
})

describe('serializeResponse', () => {
  it('emits one newline-terminated JSON line', () => {
    const line = serializeResponse(okResponse('1', { pong: true }))
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trimEnd())).toEqual({
      v: SIGNER_PROTOCOL_VERSION,
      id: '1',
      result: { pong: true }
    })
  })
})
