import { ConfigError } from '@repo/home'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergedEnv } from '../src/config'

function makeHome(files: { config?: unknown; secrets?: unknown; secretsRaw?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
  if (files.config !== undefined) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(files.config))
  }
  if (files.secretsRaw !== undefined) {
    writeFileSync(join(home, 'secrets.json'), files.secretsRaw)
  } else if (files.secrets !== undefined) {
    writeFileSync(join(home, 'secrets.json'), JSON.stringify(files.secrets), { mode: 0o600 })
  }
  return home
}

describe('mergedEnv', () => {
  it('layers config < secrets < process env, with CHAIN_ID from the resolved chain', () => {
    const home = makeHome({
      config: {
        blue: {
          defaults: { LOG_LEVEL: 'debug', MAX_FEE_GWEI: '100' },
          chains: { '8453': { MAX_FEE_GWEI: '200', RPC_URL: 'https://from-config' } }
        }
      },
      secrets: { blue: { chains: { '8453': { RPC_URL: 'https://from-secrets' } } } }
    })
    const { env, chainId } = mergedEnv({
      home,
      bot: 'blue',
      processEnv: { LOG_LEVEL: 'warn' }
    })
    expect(chainId).toBe('8453')
    expect(env.CHAIN_ID).toBe('8453')
    expect(env.MAX_FEE_GWEI).toBe('200') // chain overlay beats defaults
    expect(env.RPC_URL).toBe('https://from-secrets') // secrets beat config
    expect(env.LOG_LEVEL).toBe('warn') // process env beats files
  })

  it('resolves the chain from the --chain flag over CHAIN_ID env over the sole configured chain', () => {
    const home = makeHome({
      config: { blue: { chains: { '8453': {}, '4663': {} } } }
    })
    expect(mergedEnv({ home, bot: 'blue', chain: '4663', processEnv: {} }).chainId).toBe('4663')
    expect(mergedEnv({ home, bot: 'blue', processEnv: { CHAIN_ID: '8453' } }).chainId).toBe('8453')
    expect(() => mergedEnv({ home, bot: 'blue', processEnv: {} })).toThrow(ConfigError)
    expect(() => mergedEnv({ home, bot: 'blue', processEnv: {} })).toThrow(/multiple chains/)
  })

  it('uses the sole configured chain across both files', () => {
    const home = makeHome({
      config: { midnight: { chains: { '8453': {} } } },
      secrets: { midnight: { chains: { '8453': { RPC_URL: 'https://x' } } } }
    })
    expect(mergedEnv({ home, bot: 'midnight', processEnv: {} }).chainId).toBe('8453')
  })

  it('tolerates missing files (prod is env-only) but rejects a malformed one', () => {
    const empty = makeHome()
    expect(() => mergedEnv({ home: empty, bot: 'blue', processEnv: {} })).toThrow(
      /no chain configured/
    )
    expect(
      mergedEnv({ home: empty, bot: 'blue', chain: '8453', processEnv: {} }).env.CHAIN_ID
    ).toBe('8453')

    const malformed = makeHome({ secretsRaw: '{ not json' })
    expect(() =>
      mergedEnv({ home: malformed, bot: 'blue', chain: '8453', processEnv: {} })
    ).toThrow(ConfigError)
  })

  it('never lets an undefined process-env entry clobber a file value', () => {
    const home = makeHome({
      config: { blue: { chains: { '8453': { RPC_URL: 'https://from-config' } } } }
    })
    const { env } = mergedEnv({
      home,
      bot: 'blue',
      processEnv: { RPC_URL: undefined }
    })
    expect(env.RPC_URL).toBe('https://from-config')
  })
})
