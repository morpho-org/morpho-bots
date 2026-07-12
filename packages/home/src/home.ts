import { homedir } from 'node:os'
import { join } from 'node:path'

import { ConfigError } from './config'

/** The two runnable bots; every per-bot path under the home dir is namespaced by one of these. */
export type BotName = 'blue' | 'midnight'

// The kernel caps a Unix socket path (`sun_path`) at ~104 bytes on macOS / 108 on Linux; stay well
// under so a too-long path fails loud (exit 2) with a clear message instead of a cryptic
// bind/connect error.
const MAX_SUN_PATH_BYTES = 100

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
 * An op's disposable, best-effort cache, keyed by the op NAME (unique across the domain's flat
 * namespace, so no stage prefix is needed) and chain — e.g. `<bot>/cache/unhealthy-positions-8453.json`.
 * A rename orphans the old file, which is fine: caches are disposable and rebuilt on a miss.
 */
export function opCacheFile(home: string, bot: BotName, op: string, chainId: string): string {
  return join(home, bot, 'cache', `${op}-${chainId}.json`)
}

/**
 * The signing agent's Unix domain socket — one daemon serves every bot/chain, so it is NOT
 * namespaced by bot. Kept directly under `home` so the sun_path stays short (the OS caps it at
 * ~104 bytes). Overridable via morpho-signer's `--socket` / `SIGNER_SOCKET`.
 */
export function signerSocketFile(home: string): string {
  return join(home, 'signer.sock')
}

/** The signing agent's policy file (default-deny rule set). Overridable via `SIGNER_POLICY_PATH`. */
export function signerPolicyFile(home: string): string {
  return join(home, 'signer-policy.json')
}

/**
 * The per-chain queue daemon's Unix domain socket — one daemon per chain, domain-agnostic, so it is
 * namespaced by `chainId` only (never by bot). Kept directly under `home` so the sun_path stays short
 * (the OS caps it at ~104 bytes). Overridable via `--socket` / `QUEUED_SOCKET`.
 */
export function queuedSocketFile(home: string, chainId: string): string {
  return join(home, `queued-${chainId}.sock`)
}

/**
 * Fail loud (via {@link ConfigError} → exit 2) if a resolved Unix socket path exceeds the kernel's
 * `sun_path` cap, so a too-long path surfaces a clear, operator-fixable message rather than a cryptic
 * bind/connect error. Shared by every socket-listening/connecting command (signer, queued daemon,
 * queue thin client).
 */
export function assertSunPathLength(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath)
  if (bytes > MAX_SUN_PATH_BYTES) {
    throw new ConfigError(
      `socket path is ${bytes} bytes; a Unix socket path is capped at ~${MAX_SUN_PATH_BYTES}. ` +
        'Set a shorter socket path (via --socket or the *_SOCKET env var), or move MORPHO_BOTS_HOME ' +
        'closer to root.'
    )
  }
}

/** The per-chain queue daemon's pid lockfile, held for the daemon's lifetime (sole state writer). */
export function queuedLockFile(home: string, chainId: string): string {
  return join(home, 'locks', `queued-${chainId}.lock`)
}
