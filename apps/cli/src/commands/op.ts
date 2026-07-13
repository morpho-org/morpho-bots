import type { LogLevel } from '@repo/evm-kit'
import type { BotName } from '@repo/home'

import { createLogger } from '@repo/evm-kit'
import { botsHome, opCacheFile, warnOnLooseSecrets } from '@repo/home'
import { ensureError } from '@repo/utils'

import { loadCache, saveCache } from '../cache'
import { mergedEnv } from '../config'
import { DOMAINS } from '../domains'
import { consumeRecordBatches } from '../wire-input'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

/** Run one domain op; its exported discriminant defines how it uses stdin. */
export async function runOpCommand(
  domain: BotName,
  op: string,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()
  let adapter
  try {
    adapter = await DOMAINS[domain].loadOp(op)
  } catch (error) {
    fail('startup.error', error)
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
  const cache = loadCache(cachePath, adapter.cacheVersion)
  try {
    if (adapter.kind === 'sense') {
      const result = await adapter.senseOnce(env, {
        cache,
        runStartupChecks: cache === null,
        logger,
        emit: emitLine
      })
      saveCache(cachePath, adapter.cacheVersion, result.cache)
      return 0
    }

    if (process.stdin.isTTY) return 0
    let currentCache = cache
    const summary = await consumeRecordBatches(Bun.stdin.stream(), logger, async records => {
      const result = await adapter.actOnce(env, records, {
        cache: currentCache,
        runStartupChecks: currentCache === null,
        logger,
        emit: emitLine
      })
      currentCache = result.cache
    })
    if (currentCache !== null) saveCache(cachePath, adapter.cacheVersion, currentCache)
    return summary.invalidLines === 0 ? 0 : 2
  } catch (error) {
    logger.error('op.error', { bot: domain, op, chainId, detail: ensureError(error).message })
    return 1
  }
}
