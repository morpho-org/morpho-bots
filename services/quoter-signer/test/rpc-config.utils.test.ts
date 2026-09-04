import { describe, expect, it } from 'vitest'

import { parseRpcConfig, QUOTER_SIGNER_RPC_URL_VARIABLE } from '../src/rpc-config.utils'
import { RpcNotConfiguredError } from '../src/rpc-not-configured.error'

describe('parseRpcConfig', () => {
  it.each(['https://rpc.example', 'http://localhost:8545', 'https://rpc.example/path?key=1'])(
    'accepts the http(s) endpoint %s',
    source => {
      expect(parseRpcConfig(source)).toStrictEqual({ url: source })
    }
  )

  it.each<[string, string | undefined]>([
    ['an unset variable', undefined],
    ['a blank variable', '   '],
    ['a non-URL value', 'not a url'],
    ['a websocket endpoint', 'wss://rpc.example'],
    ['a file url', 'file:///etc/hosts']
  ])('rejects %s without echoing the value', (_description, source) => {
    let caught: unknown
    try {
      parseRpcConfig(source)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RpcNotConfiguredError)
    expect(caught).toMatchObject({
      field: QUOTER_SIGNER_RPC_URL_VARIABLE,
      reason: source === undefined || source.trim() === '' ? 'missing' : 'invalid-url',
      retryable: false
    })
    expect((caught as Error).message).not.toContain('rpc.example')
    expect((caught as Error).message).not.toContain('etc/hosts')
  })
})
