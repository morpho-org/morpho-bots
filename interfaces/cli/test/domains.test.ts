import type { OpExport } from '@repo/bot-kit'

import { OPS as BLUE_OPS } from '@repo/blue-liquidation'
import { OPS as MIDNIGHT_OPS } from '@repo/midnight-liquidation'
import { describe, expect, it } from 'bun:test'

import type { OpManifest } from '../src/domains'

import { DOMAINS, RESERVED_OP_NAMES } from '../src/domains'

// The static manifest commander registers from (domains.ts) is hand-maintained, while the actual op
// implementations live in each core's OPS table. This test is the guard that they never drift: adding
// an op is a core impl + a manifest line, and any mismatch in names/kinds/accepts fails here.
const CASES = [
  { domain: 'blue' as const, ops: BLUE_OPS },
  { domain: 'midnight' as const, ops: MIDNIGHT_OPS }
]

// Reduces a core OpExport to just the manifest-visible fields, so the comparison is exactly what the
// static manifest promises (name → kind, plus accepts for a transform) and nothing implementation.
function manifestShape(op: OpExport): OpManifest {
  return op.kind === 'act' ? { kind: 'act', accepts: op.accepts } : { kind: 'sense' }
}

describe.each(CASES)('$domain manifest is in sync with the core OPS table', ({ domain, ops }) => {
  const manifest = DOMAINS[domain].ops

  it('registers exactly the ops the core exports (no missing, no extra)', () => {
    expect(Object.keys(manifest).toSorted()).toEqual(Object.keys(ops).toSorted())
  })

  it('matches each op’s kind and accepts', () => {
    const fromCore = Object.fromEntries(
      Object.entries(ops).map(([name, op]) => [name, manifestShape(op)])
    )
    expect(manifest).toEqual(fromCore)
  })

  it('does not collide with a reserved name (queue/help/init)', () => {
    for (const name of Object.keys(manifest)) {
      expect(RESERVED_OP_NAMES.has(name)).toBe(false)
    }
  })
})
