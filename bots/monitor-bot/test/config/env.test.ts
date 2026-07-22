import { describe, expect, it } from 'vitest'

import { loadEnv } from '../../src/config/env'

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadEnv({})
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
  })

  it('parses explicit overrides', () => {
    const env = loadEnv({ PORT: '8080', LOG_LEVEL: 'debug' })
    expect(env.PORT).toBe(8080)
    expect(env.LOG_LEVEL).toBe('debug')
  })

  it('treats empty strings as unset', () => {
    const env = loadEnv({ PORT: '', LOG_LEVEL: '' })
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
  })

  it('throws on a non-numeric PORT', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow()
  })

  it('throws on an out-of-range PORT', () => {
    expect(() => loadEnv({ PORT: '70000' })).toThrow()
  })

  it('throws on an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'loud' })).toThrow()
  })

  it('leaves WALLETS_CSV_PATH undefined when unset and passes it through when set', () => {
    expect(loadEnv({}).WALLETS_CSV_PATH).toBeUndefined()
    expect(loadEnv({ WALLETS_CSV_PATH: '/data/wallets.csv' }).WALLETS_CSV_PATH).toBe(
      '/data/wallets.csv'
    )
  })
})
