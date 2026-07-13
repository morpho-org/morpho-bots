import type { BotName } from '@repo/home'
import type { Operation } from '@repo/pipeline'

type DomainRegistry = {
  loadOp: (name: string) => Promise<Operation>
}

/** Picks the loaded op or rejects an unknown runtime command. */
function pickOp(ops: Record<string, Operation>, name: string, domain: BotName): Operation {
  const op = ops[name]
  if (!op) throw new Error(`unknown op '${name}' for ${domain}`)
  return op
}

// Each op loads its implementation lazily via a STATIC-STRING dynamic import, so (a) one domain's
// spawn never pays another's module graph + soltag lens compile, (b) `--help`/usage stay fast, and
// (c) `Bun.build` can still statically bundle every branch into `dist/main.js`. `loadOp` imports the
// core index (lens + soltag); command registration itself remains import-free.
export const DOMAINS: Record<BotName, DomainRegistry> = {
  blue: {
    loadOp: async name => {
      const core = await import('@repo/blue-liquidation')
      return pickOp(core.OPS, name, 'blue')
    }
  },
  midnight: {
    loadOp: async name => {
      const core = await import('@repo/midnight-liquidation')
      return pickOp(core.OPS, name, 'midnight')
    }
  }
}
