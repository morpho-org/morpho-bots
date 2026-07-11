import type { LogLevel } from '@repo/bot-kit'
import type { BotName } from '@repo/home'

import { createLogger } from '@repo/bot-kit'
import { botsHome, opCacheFile, warnOnLooseSecrets } from '@repo/home'
import { ensureError } from '@repo/utils'

import { loadCache, saveCache } from '../cache'
import { mergedEnv } from '../config'
import { DOMAINS } from '../domains'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

/**
 * A source op (`<domain> <op>`, e.g. `blue unhealthy-positions`): the read-only, lockless, secret-free
 * sensor. Merges config → validates the op's stage config (fail → exit 2) → restores the op's
 * best-effort cache → runs `senseOnce`, streaming one `opportunity` JSON line per record to stdout →
 * persists the refreshed cache. A transient error (RPC/discovery) is a stderr log plus exit 1; there
 * is no lock. `op` is guaranteed a source by command registration; a non-source is a deploy error → 2.
 */
export async function runSourceCommand(
  domain: BotName,
  op: string,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()
  const adapter = await DOMAINS[domain].loadOp(op)
  if (adapter.kind !== 'sense') {
    fail('startup.error', new Error(`op '${op}' is not a source`))
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
  const cachePath = opCacheFile(home, domain, op, chainId)
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
    logger.error('sense.error', { bot: domain, op, chainId, detail: ensureError(error).message })
    return 1
  }
}
