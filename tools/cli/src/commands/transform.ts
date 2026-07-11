import type { LogLevel } from '@repo/bot-kit'
import type { BotName } from '@repo/home'

import { createLogger } from '@repo/bot-kit'
import { botsHome, opCacheFile, queueStateFile, readAdvisory, warnOnLooseSecrets } from '@repo/home'
import { ensureError } from '@repo/utils'

import { loadCache, saveCache } from '../cache'
import { mergedEnv } from '../config'
import { DOMAINS } from '../domains'
import { collectActIds } from '../wire-input'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

/**
 * A transform op (`<domain> <op> [ids...]`, e.g. `blue liquidate`): maps the ids of the source op it
 * `accepts` to freshly simulated tx records. Input precedence: positional ids if present, else stdin
 * (bare ids or `opportunity` records whose domain+op the transform accepts — foreign lines warn+skip).
 * TTY stdin with no positional ids is a no-op (exit 0). Builds the read-only advisory (backoff +
 * inflight) from the queue state file, restores the op's best-effort cache, runs `actOnce` streaming
 * `tx`/`outcome` lines to stdout, and persists the refreshed cache. No lock; no signer key. A
 * wire-version skew is exit 2; a transient error is a stderr log plus exit 1. `op` is guaranteed a
 * transform by command registration; a non-transform is a deploy error → 2.
 */
export async function runTransformCommand(
  domain: BotName,
  op: string,
  opts: { chain?: string | undefined },
  positionalIds: string[]
): Promise<number> {
  const home = botsHome()
  const adapter = await DOMAINS[domain].loadOp(op)
  if (adapter.kind !== 'act') {
    fail('startup.error', new Error(`op '${op}' is not a transform`))
    return 2
  }

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
    const collected = collectActIds(await Bun.stdin.text(), domain, adapter.accepts, logger)
    if (collected.versionSkew) {
      fail('wire.version_skew', new Error('input record has a newer wire version than this build'))
      return 2
    }
    ids = collected.ids
  }

  // Advisory only: the queue is authoritative for both backoff and inflight dedupe. Read-only load.
  const advisory = readAdvisory(queueStateFile(home, domain, chainId))
  const cachePath = opCacheFile(home, domain, op, chainId)
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
    logger.error('act.error', { bot: domain, op, chainId, detail: ensureError(error).message })
    return 1
  }
}
