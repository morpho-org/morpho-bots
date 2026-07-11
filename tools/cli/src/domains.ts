import type { OpExport } from '@repo/bot-kit'
import type { BotName } from '@repo/home'

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
}

// Both liquidation cores expose the same two ops, so they share one manifest. `unhealthy-positions`
// is the source (today's sensor); `liquidate` is the transform that consumes it.
const LIQUIDATION_OPS = {
  'unhealthy-positions': { kind: 'sense' },
  liquidate: { kind: 'act', accepts: 'unhealthy-positions' }
} as const satisfies Record<string, OpManifest>

// Names that can never be an op — the flat namespace also holds `queue` (the stateful sink), the
// top-level `signer` daemon, and the commander built-ins. The sync test fails if a core's `OPS` ever
// collides with one of these.
export const RESERVED_OP_NAMES: ReadonlySet<string> = new Set(['queue', 'signer', 'help', 'init'])

/** Picks the loaded op or throws — commander only ever calls `loadOp` with a registered manifest name. */
function pickOp(ops: Record<string, OpExport>, name: string, domain: BotName): OpExport {
  const op = ops[name]
  if (!op) throw new Error(`unknown op '${name}' for ${domain}`)
  return op
}

// Each op loads its implementation lazily via a STATIC-STRING dynamic import, so (a) one domain's
// spawn never pays another's module graph + soltag lens compile, (b) `--help`/usage stay fast, and
// (c) `Bun.build` can still statically bundle every branch into `dist/main.js`. `loadOp` imports the
// core index (lens + soltag). The static `ops` manifest carries no core code, so registration stays
// import-free. `queue` is no longer a domain seam here — it is a thin, domain-agnostic client that
// relays to the `queued` daemon (`commands/queue.ts`), importing no core.
export const DOMAINS: Record<BotName, DomainRegistry> = {
  blue: {
    ops: LIQUIDATION_OPS,
    loadOp: async name => {
      const core = await import('@repo/blue-liquidation')
      return pickOp(core.OPS, name, 'blue')
    }
  },
  midnight: {
    ops: LIQUIDATION_OPS,
    loadOp: async name => {
      const core = await import('@repo/midnight-liquidation')
      return pickOp(core.OPS, name, 'midnight')
    }
  }
}
