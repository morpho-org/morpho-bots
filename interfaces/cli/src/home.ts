import { homedir } from 'node:os'
import { join } from 'node:path'

/** The two runnable bots; every per-bot path under the home dir is namespaced by one of these. */
export type BotName = 'blue' | 'midnight'

/**
 * Root of all operator config and state. `MORPHO_BOTS_HOME` relocates it — tests point it at a
 * temp dir, and the Docker image points it at a persistent volume.
 */
export function botsHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.MORPHO_BOTS_HOME
  // An empty MORPHO_BOTS_HOME must not silently resolve paths against the cwd.
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.morpho-bots')
}

export function configFile(home: string): string {
  return join(home, 'config.json')
}

export function secretsFile(home: string): string {
  return join(home, 'secrets.json')
}

/**
 * The queue's stateful file — `{ version, queue, backoff }`, written only by `queue` (atomic
 * tmp+rename) and read-only by `act` (for its advisory backoff/inflight snapshot). Replaces the old
 * monolithic `<bot>/state/<chainId>.json`.
 */
export function queueStateFile(home: string, bot: BotName, chainId: string): string {
  return join(home, bot, 'queue', `${chainId}.json`)
}

/**
 * An op's disposable, best-effort cache, keyed by the op NAME (unique across the domain's flat
 * namespace, so no stage prefix is needed) and chain — e.g. `<bot>/cache/unhealthy-positions-8453.json`.
 * A rename orphans the old file, which is fine: caches are disposable and rebuilt on a miss.
 */
export function opCacheFile(home: string, bot: BotName, op: string, chainId: string): string {
  return join(home, bot, 'cache', `${op}-${chainId}.json`)
}

/** The per-(bot, chain) pid lockfile, held by `queue` only (the sole state writer). */
export function lockFile(home: string, bot: BotName, chainId: string): string {
  return join(home, 'locks', `${bot}-${chainId}.lock`)
}
