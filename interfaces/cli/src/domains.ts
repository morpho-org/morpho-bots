import type {
  BackoffState,
  Logger,
  LogLevel,
  OpportunityRecord,
  OutcomeRecord,
  TxRecord
} from '@repo/bot-kit'
import type { Chain, Hex } from 'viem'

import type { BotName } from './home'

type Env = Record<string, string | undefined>

/** The stage-config validation each command runs before touching the chain (throws → exit 2). */
type ValidateConfig = (env: Env) => { logLevel: LogLevel }

/** `sense`'s per-domain seam: cache version + config gate + the one-shot sensor. */
type SenseAdapter = {
  cacheVersion: number
  validateConfig: ValidateConfig
  senseOnce: (
    env: Env,
    opts: {
      cache: unknown
      runStartupChecks: boolean
      logger: Logger
      emit: (record: OpportunityRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/** `act`'s per-domain seam: cache version + config gate + the one-shot actor. */
type ActAdapter = {
  cacheVersion: number
  validateConfig: ValidateConfig
  actOnce: (
    env: Env,
    ids: readonly string[],
    opts: {
      cache: unknown
      advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
      runStartupChecks: boolean
      logger: Logger
      emit: (record: TxRecord | OutcomeRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/**
 * The queue config the CLI wires into `createSigner`/`createPendingQueue`. `sendRpcUrl` is optional
 * so blue's key-set (which has no dedicated broadcast endpoint) is assignable alongside midnight's.
 */
export type QueueConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  sendRpcUrl?: string | undefined
  logLevel: LogLevel
  liquidatorPrivateKey: Hex
  maxFeeWei: bigint
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

/** Per-domain queue policy: wire `op`, settled cooldown, and an optional protocol revert decoder. */
export type QueuePolicy = {
  op: string
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

/**
 * `queue`'s per-domain seam. Unlike sense/act it does NOT import the core index — only the core's
 * `./queue` subpath (config + policy) — so the stateful signer path stays free of lens/soltag
 * exposure (see the pipeline TIB). The CLI wires bot-kit's `createSigner` + `createPendingQueue`
 * directly around these two values.
 */
export type QueueAdapter = {
  loadConfig: (env: Env) => QueueConfig
  policy: QueuePolicy
}

type DomainRegistry = {
  sense: () => Promise<SenseAdapter>
  act: () => Promise<ActAdapter>
  queue: () => Promise<QueueAdapter>
}

// Each stage loads its adapter lazily via a STATIC-STRING dynamic import, so (a) one domain's spawn
// never pays another's module graph + soltag lens compile, (b) `--help`/usage stay fast, and (c)
// `Bun.build` can still statically bundle every branch into `dist/main.js`. sense/act import the core
// index (lens + soltag); queue imports ONLY the `./queue` subpath + bot-kit (no lens/soltag).
export const DOMAINS: Record<BotName, DomainRegistry> = {
  blue: {
    sense: async () => {
      const core = await import('@repo/blue-liquidation')
      return {
        cacheVersion: core.SENSE_CACHE_VERSION,
        validateConfig: env => core.loadSenseConfig(env),
        senseOnce: (env, opts) =>
          core.senseOnce(env, {
            cache: opts.cache as import('@repo/blue-liquidation').BlueSenseCache | null,
            runStartupChecks: opts.runStartupChecks,
            logger: opts.logger,
            emit: opts.emit
          })
      }
    },
    act: async () => {
      const core = await import('@repo/blue-liquidation')
      return {
        cacheVersion: core.ACT_CACHE_VERSION,
        validateConfig: env => core.loadActConfig(env),
        actOnce: (env, ids, opts) =>
          core.actOnce(env, ids, {
            cache: opts.cache as import('@repo/blue-liquidation').BlueActCache | null,
            advisory: opts.advisory,
            runStartupChecks: opts.runStartupChecks,
            logger: opts.logger,
            emit: opts.emit
          })
      }
    },
    queue: async () => {
      const q = await import('@repo/blue-liquidation/queue')
      return { loadConfig: env => q.loadQueueConfig(env), policy: q.queuePolicy }
    }
  },
  midnight: {
    sense: async () => {
      const core = await import('@repo/midnight-liquidation')
      return {
        cacheVersion: core.SENSE_CACHE_VERSION,
        validateConfig: env => core.loadSenseConfig(env),
        senseOnce: (env, opts) =>
          core.senseOnce(env, {
            cache: opts.cache as import('@repo/midnight-liquidation').MidnightSenseCache | null,
            runStartupChecks: opts.runStartupChecks,
            logger: opts.logger,
            emit: opts.emit
          })
      }
    },
    act: async () => {
      const core = await import('@repo/midnight-liquidation')
      return {
        cacheVersion: core.ACT_CACHE_VERSION,
        validateConfig: env => core.loadActConfig(env),
        actOnce: (env, ids, opts) =>
          core.actOnce(env, ids, {
            cache: opts.cache as import('@repo/midnight-liquidation').MidnightActCache | null,
            advisory: opts.advisory,
            runStartupChecks: opts.runStartupChecks,
            logger: opts.logger,
            emit: opts.emit
          })
      }
    },
    queue: async () => {
      const q = await import('@repo/midnight-liquidation/queue')
      return { loadConfig: env => q.loadQueueConfig(env), policy: q.queuePolicy }
    }
  }
}
