import type { Logger } from '@repo/bot-kit'

import { Global, Module } from '@nestjs/common'
import { ensureError } from '@repo/utils'
import { readFileSync } from 'node:fs'

import type { MonitorEnv } from '../config/env'

import { ENV } from '../config/env'
import { LOGGER } from '../logging/logger.provider'
import { InMemoryWalletCrmStore, WALLET_CRM_STORE } from './wallet-crm.store'
import { parseWalletCrmCsv } from './wallet-csv'

/**
 * Load the Attio wallet-CRM export into the address-keyed store at boot. `WALLETS_CSV_PATH` unset =>
 * an empty store (wallet lookups become no-ops). Path set but unreadable or malformed => throw so
 * the bootstrap fails loudly, matching the repo's fail-loud config convention: a half-loaded CRM is
 * worse than a boot that refuses to start.
 */
export function buildWalletCrmStore(env: MonitorEnv, logger: Logger): InMemoryWalletCrmStore {
  const path = env.WALLETS_CSV_PATH
  if (!path) {
    logger.info('wallets.disabled', {
      reason: 'WALLETS_CSV_PATH is unset — wallet store is empty'
    })
    return new InMemoryWalletCrmStore()
  }

  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`failed to read WALLETS_CSV_PATH (${path}): ${ensureError(error).message}`, {
      cause: error
    })
  }

  const parsed = parseWalletCrmCsv(content)
  logger.info('wallets.loaded', {
    path,
    count: parsed.rows.length,
    skippedInvalidAddress: parsed.skippedInvalidAddress,
    duplicateAddresses: parsed.duplicateAddresses
  })
  return new InMemoryWalletCrmStore(parsed.rows)
}

// Global so any feature module can inject WALLET_CRM_STORE without importing this module — there is
// exactly one wallet lookup table per process, built once at boot.
@Global()
@Module({
  providers: [
    { provide: WALLET_CRM_STORE, useFactory: buildWalletCrmStore, inject: [ENV, LOGGER] }
  ],
  exports: [WALLET_CRM_STORE]
})
export class WalletsModule {}
