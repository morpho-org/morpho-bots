import type { LogLevel } from '@repo/bot-kit'

import { createLogger } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'

import type { BotName } from '../home'

import { loadCache, saveCache } from '../cache'
import { mergedEnv, warnOnLooseSecrets } from '../config'
import { DOMAINS } from '../domains'
import { actCacheFile, botsHome, queueStateFile } from '../home'
import { readAdvisory } from '../queue-state'
import { collectActIds } from '../wire-input'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

/**
 * `<domain> act`: maps opportunity ids to freshly simulated tx records. Input precedence: positional
 * ids if present, else stdin (bare ids or `opportunity` records for this domain). TTY stdin with no
 * positional ids is a no-op (exit 0). Builds the read-only advisory (backoff + inflight) from the
 * queue state file, restores the best-effort act cache, runs `actOnce` streaming `tx`/`outcome`
 * lines to stdout, and persists the refreshed cache. No lock; no signer key. A wire-version skew is
 * exit 2; a transient error is a stderr log plus exit 1.
 */
export async function runActCommand(
  domain: BotName,
  opts: { chain?: string | undefined },
  positionalIds: string[]
): Promise<number> {
  const home = botsHome()
  const adapter = await DOMAINS[domain].act()

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

  let ids: string[]
  if (positionalIds.length > 0) {
    ids = positionalIds
  } else if (process.stdin.isTTY) {
    // Interactive shell with no ids to act on — nothing to do, cleanly.
    return 0
  } else {
    const collected = collectActIds(await Bun.stdin.text(), domain, logger)
    if (collected.versionSkew) {
      fail('wire.version_skew', new Error('input record has a newer wire version than this build'))
      return 2
    }
    ids = collected.ids
  }

  // Advisory only: the queue is authoritative for both backoff and inflight dedupe. Read-only load.
  const advisory = readAdvisory(queueStateFile(home, domain, chainId))
  const cachePath = actCacheFile(home, domain, chainId)
  const cache = loadCache(cachePath, adapter.cacheVersion)

  try {
    const result = await adapter.actOnce(env, ids, {
      cache,
      advisory,
      runStartupChecks: cache === null,
      logger,
      emit: emitLine
    })
    saveCache(cachePath, adapter.cacheVersion, result.cache)
    return 0
  } catch (error) {
    logger.error('act.error', { bot: domain, chainId, detail: ensureError(error).message })
    return 1
  }
}
