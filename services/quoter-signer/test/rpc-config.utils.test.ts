import { describe, expect, it } from 'vitest'

import type { RpcConfigurationReason } from '../src/rpc-not-configured.error'

import { parseRpcConfig, QUOTER_SIGNER_RPC_URL_VARIABLE } from '../src/rpc-config.utils'
import { RpcNotConfiguredError } from '../src/rpc-not-configured.error'

describe('parseRpcConfig', () => {
  it.each(['https://rpc.example', 'http://localhost:8545', 'https://rpc.example/path?key=1'])(
    'accepts the http(s) endpoint %s',
    source => {
      expect(parseRpcConfig(source)).toStrictEqual({ url: source })
    }
  )

  it.each<[string, string | undefined, RpcConfigurationReason]>([
    ['an unset variable', undefined, 'missing'],
    ['a blank variable', '   ', 'missing'],
    ['a non-URL value', 'not a url', 'invalid-url'],
    ['a websocket endpoint', 'wss://rpc.example', 'invalid-url'],
    ['a file url', 'file:///etc/hosts', 'invalid-url']
  ])('rejects %s without echoing the value', (_description, source, reason) => {
    let caught: unknown
    try {
      parseRpcConfig(source)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RpcNotConfiguredError)
    expect(caught).toMatchObject({
      field: QUOTER_SIGNER_RPC_URL_VARIABLE,
      reason,
      retryable: false
    })
    expect((caught as Error).message).not.toContain('rpc.example')
    expect((caught as Error).message).not.toContain('etc/hosts')
  })
})
