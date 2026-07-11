import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError, readSettings, warnOnLooseSecrets } from '../src/config'

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

describe('readSettings', () => {
  it('returns null for a missing file (prod is env-only, files are optional)', () => {
    expect(readSettings(join(makeHome(), 'config.json'))).toBeNull()
  })

  it('parses a present, well-formed settings file', () => {
    const home = makeHome({ config: { blue: { chains: { '8453': { RPC_URL: 'https://x' } } } } })
    expect(readSettings(join(home, 'config.json'))).toEqual({
      blue: { chains: { '8453': { RPC_URL: 'https://x' } } }
    })
  })

  it('throws ConfigError on malformed JSON rather than silently ignoring it', () => {
    const home = makeHome({ secretsRaw: '{ not json' })
    expect(() => readSettings(join(home, 'secrets.json'))).toThrow(ConfigError)
  })

  it('throws ConfigError when the file is not a JSON object', () => {
    const home = makeHome({ config: [1, 2, 3] })
    expect(() => readSettings(join(home, 'config.json'))).toThrow(/must be a JSON object/)
  })
})

describe('warnOnLooseSecrets', () => {
  it('warns for group/world-accessible secrets and stays quiet for 0600 or missing', () => {
    const loose = makeHome({ secrets: {} })
    chmodSync(join(loose, 'secrets.json'), 0o644)
    expect(warnOnLooseSecrets(loose)).toBe(true)

    const tight = makeHome({ secrets: {} })
    expect(warnOnLooseSecrets(tight)).toBe(false)

    const missing = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
    mkdirSync(missing, { recursive: true })
    expect(warnOnLooseSecrets(missing)).toBe(false)
  })
})
