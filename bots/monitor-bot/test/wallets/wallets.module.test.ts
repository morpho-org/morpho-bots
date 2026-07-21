import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadEnv } from '../../src/config/env'
import { buildWalletCrmStore } from '../../src/wallets/wallets.module'
import { fakeLogger } from '../helpers'

const CSV = [
  '"Record ID","Record","\tCompany"',
  '"b3dba9ed","\t0xc5e0e2bd8b8663c621b5051d863d072295da9720","\tKraken"'
].join('\n')

describe('buildWalletCrmStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wallet-crm-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty store and logs when WALLETS_CSV_PATH is unset', () => {
    const logger = fakeLogger()
    const store = buildWalletCrmStore(loadEnv({}), logger)
    expect(store.size).toBe(0)
    expect(logger.info).toHaveBeenCalledWith('wallets.disabled', expect.anything())
  })

  it('loads the CSV into an address-keyed store and logs the count', () => {
    const path = join(dir, 'wallets.csv')
    writeFileSync(path, CSV)
    const logger = fakeLogger()
    const store = buildWalletCrmStore(loadEnv({ WALLETS_CSV_PATH: path }), logger)
    expect(store.size).toBe(1)
    expect(store.get('0xc5e0e2bd8b8663c621b5051d863d072295da9720')).toEqual({
      'Record ID': 'b3dba9ed',
      Company: 'Kraken'
    })
    expect(logger.info).toHaveBeenCalledWith(
      'wallets.loaded',
      expect.objectContaining({ count: 1 })
    )
  })

  it('throws loudly when the path is set but the file is missing', () => {
    const path = join(dir, 'does-not-exist.csv')
    expect(() => buildWalletCrmStore(loadEnv({ WALLETS_CSV_PATH: path }), fakeLogger())).toThrow(
      /failed to read WALLETS_CSV_PATH/
    )
  })
})
