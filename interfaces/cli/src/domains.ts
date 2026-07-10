import type { LogLevel, OpExport } from '@repo/bot-kit'
import type { Chain, Hex } from 'viem'

import type { BotName } from './home'

type Env = Record<string, string | undefined>

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

/**
 * Per-domain queue policy: settled cooldown and an optional protocol revert decoder. The outcome
 * records' `op` is NOT policy — the queue derives it from the incoming `tx.op` envelope (submit path)
 * or the persisted label's `<domain>:<op>:` prefix (onSettled path), so nothing pins it here.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

/**
 * `queue`'s per-domain seam. Unlike an op it does NOT import the core index — only the core's
 * `./queue` subpath (config + policy) — so the stateful signer path stays free of lens/soltag
 * exposure (see the pipeline TIB). The CLI wires bot-kit's `createSigner` + `createPendingQueue`
 * directly around these two values.
 */
export type QueueAdapter = {
  loadConfig: (env: Env) => QueueConfig
  policy: QueuePolicy
}

/**
 * A single op's STATIC manifest entry — just enough for commander to register the `<domain> <op>`
 * command at startup without importing the core (which would drag the soltag/lens graph into every
 * spawn, including `queue`'s). The op name is the map key; a source needs only its `kind`, a
 * transform additionally names the source op it `accepts`. A sync test asserts each manifest matches
 * the core's `OPS` table exactly, so this static data can never drift from the lazy implementation.
 */
export type OpManifest = { kind: 'sense' } | { kind: 'act'; accepts: string }

type DomainRegistry = {
  ops: Record<string, OpManifest>
  loadOp: (name: string) => Promise<OpExport>
  queue: () => Promise<QueueAdapter>
}

// Both liquidation cores expose the same two ops, so they share one manifest. `unhealthy-positions`
// is the source (today's sensor); `liquidate` is the transform that consumes it.
const LIQUIDATION_OPS = {
  'unhealthy-positions': { kind: 'sense' },
  liquidate: { kind: 'act', accepts: 'unhealthy-positions' }
} as const satisfies Record<string, OpManifest>

// Names that can never be an op — the flat namespace also holds `queue` (the stateful sink) and the
// commander built-ins. The sync test fails if a core's `OPS` ever collides with one of these.
export const RESERVED_OP_NAMES: ReadonlySet<string> = new Set(['queue', 'help', 'init'])

/** Picks the loaded op or throws — commander only ever calls `loadOp` with a registered manifest name. */
function pickOp(ops: Record<string, OpExport>, name: string, domain: BotName): OpExport {
  const op = ops[name]
  if (!op) throw new Error(`unknown op '${name}' for ${domain}`)
  return op
}

// Each op/queue loads its implementation lazily via a STATIC-STRING dynamic import, so (a) one
// domain's spawn never pays another's module graph + soltag lens compile, (b) `--help`/usage stay
// fast, and (c) `Bun.build` can still statically bundle every branch into `dist/main.js`. `loadOp`
// imports the core index (lens + soltag); `queue` imports ONLY the `./queue` subpath + bot-kit (no
// lens/soltag). The static `ops` manifest carries no core code, so registration stays import-free.
export const DOMAINS: Record<BotName, DomainRegistry> = {
  blue: {
    ops: LIQUIDATION_OPS,
    loadOp: async name => {
      const core = await import('@repo/blue-liquidation')
      return pickOp(core.OPS, name, 'blue')
    },
    queue: async () => {
      const q = await import('@repo/blue-liquidation/queue')
      return { loadConfig: env => q.loadQueueConfig(env), policy: q.queuePolicy }
    }
  },
  midnight: {
    ops: LIQUIDATION_OPS,
    loadOp: async name => {
      const core = await import('@repo/midnight-liquidation')
      return pickOp(core.OPS, name, 'midnight')
    },
    queue: async () => {
      const q = await import('@repo/midnight-liquidation/queue')
      return { loadConfig: env => q.loadQueueConfig(env), policy: q.queuePolicy }
    }
  }
}
