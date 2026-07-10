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

export function stateFile(home: string, bot: BotName, chainId: string): string {
  return join(home, bot, 'state', `${chainId}.json`)
}

export function lockFile(home: string, bot: BotName, chainId: string): string {
  return join(home, 'locks', `${bot}-${chainId}.lock`)
}
