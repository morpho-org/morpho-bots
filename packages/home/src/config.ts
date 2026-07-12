import { readFileSync, statSync } from 'node:fs'

import type { BotName } from './home'

import { secretsFile } from './home'

/** Thrown for anything the operator must fix before retrying is useful — mapped to exit code 2. */
export class ConfigError extends Error {}

// One bot's section in config.json / secrets.json: env-var names as keys, chain overlays by id.
export type BotSection = {
  defaults?: Record<string, string>
  chains?: Record<string, Record<string, string>>
}
type SettingsFile = Partial<Record<BotName, BotSection>>

// Missing file → null (prod is env-only, files are optional). Present-but-malformed → ConfigError:
// silently ignoring a broken file would run the bot with half its config missing.
export function readSettings(path: string): SettingsFile | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must be a JSON object`)
  }
  return parsed as SettingsFile
}

/**
 * True (and warns on stderr) when secrets.json is group- or world-accessible. A warning, not an
 * error: the operator may be on a filesystem where the mode is a lie (e.g. some mounts), and
 * refusing to run would turn a hygiene nit into an outage.
 */
export function warnOnLooseSecrets(home: string): boolean {
  let mode: number
  try {
    mode = statSync(secretsFile(home)).mode
  } catch {
    return false
  }
  if ((mode & 0o077) === 0) return false
  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'secrets.loose_permissions',
      file: secretsFile(home),
      detail: 'secrets.json is group/world accessible — run: chmod 600 ' + secretsFile(home)
    })
  )
  return true
}
