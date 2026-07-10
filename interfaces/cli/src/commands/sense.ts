import type { LogLevel } from '@repo/bot-kit'

import { createLogger } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'

import type { BotName } from '../home'

import { loadCache, saveCache } from '../cache'
import { mergedEnv, warnOnLooseSecrets } from '../config'
import { DOMAINS } from '../domains'
import { botsHome, senseCacheFile } from '../home'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

/**
 * `<domain> sense`: the read-only, lockless, secret-free sensor. Merges config → validates the
 * sense-stage config (fail → exit 2) → restores the best-effort sense cache → runs `senseOnce`,
 * streaming one `opportunity` JSON line per actionable position to stdout → persists the refreshed
 * cache. A transient error (RPC/discovery) is a stderr log plus exit 1; there is no lock.
 */
export async function runSenseCommand(
  domain: BotName,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()
  const adapter = await DOMAINS[domain].sense()

  let env: Env
  let chainId: string
  let logLevel: LogLevel
  try {
    warnOnLooseSecrets(home)
    ;({ env, chainId } = mergedEnv({ home, bot: domain, chain: opts.chain }))
    ;({ logLevel } = adapter.validateConfig(env))
  } catch (error) {
    fail('startup.error', error)
    return 2
  }

  const logger = createLogger(logLevel)
  const cachePath = senseCacheFile(home, domain, chainId)
  // Best-effort: a missing/corrupt/stale cache degrades to a rebuild (and gates startup checks).
  const cache = loadCache(cachePath, adapter.cacheVersion)

  try {
    const result = await adapter.senseOnce(env, {
      cache,
      runStartupChecks: cache === null,
      logger,
      emit: emitLine
    })
    saveCache(cachePath, adapter.cacheVersion, result.cache)
    return 0
  } catch (error) {
    logger.error('sense.error', { bot: domain, chainId, detail: ensureError(error).message })
    return 1
  }
}
