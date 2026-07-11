import type { BotName } from '@repo/home'
import type { Chain } from 'viem'

import { ConfigError } from '@repo/home'

/**
 * The lens/soltag-free per-domain queue surface, resolved lazily from each core's `"./queue"` subpath.
 * The daemon is domain-agnostic — any bot hands `tx`/`outcome` records to the same per-chain daemon —
 * so it needs only two things per domain: the {@link QueuePolicy} (`createPendingQueue`'s
 * settled-cooldown + optional revert decoder) and the chain map (to resolve `CHAIN_ID` → a viem
 * `Chain` without importing the core index). `CHAIN_MAP`'s entries carry more than `chain` (Blue also
 * carries `morpho`/`network`), but the daemon reads only `chain`, so the type is narrowed here.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

type QueueModule = {
  queuePolicy: QueuePolicy
  CHAIN_MAP: Record<number, { chain: Chain }>
}

/**
 * The domain registry: `BotName` → a loader for that core's `./queue` subpath. Static-string dynamic
 * imports keep this bundleable (`Bun.build` statically resolves each branch) while paying no other
 * domain's module graph until it is asked for. Keying on `BotName` makes adding a bot a compile error
 * here — the daemon can never silently drop a domain. Mirrors `tools/cli/src/domains.ts`, minus the
 * op manifests (the daemon has no source/transform ops — it is a pure sink).
 */
const DOMAINS: Record<BotName, () => Promise<QueueModule>> = {
  blue: () => import('@repo/blue-liquidation/queue'),
  midnight: () => import('@repo/midnight-liquidation/queue')
}

/** Every registered domain, in a stable order for startup restore and status pending sums. */
export const DOMAIN_NAMES: readonly BotName[] = ['blue', 'midnight']

/**
 * Resolves `chainId` to its viem `Chain` by scanning the union of every registered domain's chain
 * map — so Robinhood's `defineChain` (Blue-only) resolves without duplicating it here. Throws
 * {@link ConfigError} (exit 2) when no registered domain knows the chain: an explicit `--chain`/
 * `CHAIN_ID` that no bot supports is operator misconfig, not a transient.
 */
export async function resolveChain(chainId: number): Promise<Chain> {
  const seen = new Set<number>()
  for (const name of DOMAIN_NAMES) {
    const { CHAIN_MAP } = await DOMAINS[name]()
    for (const id of Object.keys(CHAIN_MAP)) seen.add(Number(id))
    const entry = CHAIN_MAP[chainId]
    if (entry) return entry.chain
  }
  throw new ConfigError(
    `no registered domain supports chain ${chainId} — supported chains are ${[...seen].join(', ')}`
  )
}

/** Loads every domain's queue policy, keyed by `BotName`, for eager runtime instantiation at startup. */
export async function loadPolicies(): Promise<Record<BotName, QueuePolicy>> {
  const entries = await Promise.all(
    DOMAIN_NAMES.map(async name => [name, (await DOMAINS[name]()).queuePolicy] as const)
  )
  return Object.fromEntries(entries) as Record<BotName, QueuePolicy>
}
