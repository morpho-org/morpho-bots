import type { BluePersistedState } from '@repo/blue-liquidation'
import type { Logger } from '@repo/bot-kit'
import type { MidnightPersistedState } from '@repo/midnight-liquidation'

import { createLogger } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'

import type { BotName } from '../home'

import { mergedEnv, warnOnLooseSecrets } from '../config'
import { botsHome, lockFile, stateFile } from '../home'
import { acquireLock, releaseLock } from '../lock'
import { loadState, saveState } from '../state'

type Env = Record<string, string | undefined>

// Per-bot seam between the untyped state file and each core's typed tickOnce. The casts are safe:
// loadState only returns a payload whose `version` matched the core's STATE_VERSION, and tickOnce
// re-checks it.
type BotAdapter = {
  stateVersion: number
  validateConfig: (env: Env) => { logLevel: 'debug' | 'info' | 'warn' | 'error' }
  tick: (
    env: Env,
    opts: { state: unknown; runStartupChecks: boolean; logger: Logger }
  ) => Promise<{ state: unknown }>
}

// Cores load lazily so one bot's tick never pays the OTHER bot's module graph + soltag lens
// compile — a per-spawn cost in the one-shot model. The type-only imports above are erased.
const ADAPTERS: Record<BotName, () => Promise<BotAdapter>> = {
  blue: async () => {
    const core = await import('@repo/blue-liquidation')
    return {
      stateVersion: core.STATE_VERSION,
      validateConfig: core.loadConfig,
      tick: (env, opts) =>
        core.tickOnce(env, {
          ...(opts.state ? { state: opts.state as BluePersistedState } : {}),
          runStartupChecks: opts.runStartupChecks,
          logger: opts.logger
        })
    }
  },
  midnight: async () => {
    const core = await import('@repo/midnight-liquidation')
    return {
      stateVersion: core.STATE_VERSION,
      validateConfig: core.loadConfig,
      tick: (env, opts) =>
        core.tickOnce(env, {
          ...(opts.state ? { state: opts.state as MidnightPersistedState } : {}),
          runStartupChecks: opts.runStartupChecks,
          logger: opts.logger
        })
    }
  }
}

function fail(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, error: ensureError(error).message }))
}

/**
 * One full liquidation cycle for `bot`, then exit. Returns the process exit code — the loop/cron
 * contract: 0 = tick done or skipped under a live lock (overlap is normal), 1 = transient tick
 * error (retry next interval), 2 = config/usage error (retrying is pointless; loop wrappers must
 * stop rather than crash-loop silently).
 */
export async function runTickCommand(
  bot: BotName,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()
  const adapter = await ADAPTERS[bot]()

  // Everything the operator must fix (bad files, unresolvable chain, invalid bot config) fails
  // BEFORE any chain interaction, as exit 2. Config validation is re-run inside tickOnce — cheap,
  // and it keeps tickOnce self-contained.
  let env: Env
  let chainId: string
  let logLevel: 'debug' | 'info' | 'warn' | 'error'
  try {
    warnOnLooseSecrets(home)
    ;({ env, chainId } = mergedEnv({ home, bot, chain: opts.chain }))
    ;({ logLevel } = adapter.validateConfig(env))
  } catch (error) {
    fail('startup.error', error)
    return 2
  }

  const logger = createLogger(logLevel)
  const lockPath = lockFile(home, bot, chainId)
  const lock = acquireLock(lockPath)
  if (!lock.acquired) {
    logger.info('tick.skipped', { bot, chainId, reason: 'lock_held', holderPid: lock.holderPid })
    return 0
  }
  if (lock.stolen) {
    // Loud by design: a steal means the previous tick died without releasing — worth investigating.
    logger.warn('lock.stolen', { bot, chainId, lockPath })
  }

  try {
    const statePath = stateFile(home, bot, chainId)
    const { state, reset } = loadState(statePath, adapter.stateVersion)
    if (reset && reset !== 'missing') logger.warn('state.reset', { bot, chainId, reason: reset })

    logger.info('tick.start', { bot, chainId, freshState: state === null })
    const result = await adapter.tick(env, {
      state,
      // Fresh state (first run, corrupt file, or schema bump) → run the boot-time liveness checks.
      runStartupChecks: state === null,
      logger
    })
    saveState(statePath, result.state)
    return 0
  } catch (error) {
    logger.error('tick.error', { bot, chainId, detail: ensureError(error).message })
    return 1
  } finally {
    releaseLock(lockPath)
  }
}
