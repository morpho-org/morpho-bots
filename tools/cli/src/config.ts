import { readFileSync, statSync } from 'node:fs'

import type { BotName } from './home'

import { configFile, secretsFile } from './home'

/** Thrown for anything the operator must fix before retrying is useful — mapped to exit code 2. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

// One bot's section in config.json / secrets.json: env-var names as keys, chain overlays by id.
type BotSection = {
  defaults?: Record<string, string>
  chains?: Record<string, Record<string, string>>
}
// The signing agent's section is chain-less: one daemon serves every chain, and the per-chain
// policy lives in the policy file (not env), so there are no chain overlays here.
type SignerSection = { defaults?: Record<string, string> }
type SettingsFile = Partial<Record<BotName, BotSection>> & { signer?: SignerSection }

// Missing file → null (prod is env-only, files are optional). Present-but-malformed → ConfigError:
// silently ignoring a broken file would run the bot with half its config missing.
function readSettings(path: string): SettingsFile | null {
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

function overlay(section: BotSection | undefined, chainId: string): Record<string, string> {
  return { ...section?.defaults, ...section?.chains?.[chainId] }
}

// Only keys the caller actually set — spreading raw process.env would inject `undefined` values
// that clobber file-sourced settings under exactOptionalPropertyTypes-style merges.
function definedOnly(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
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

/**
 * Builds the env-shaped table the bot cores' unchanged `loadConfig(env)` consumes. Sources, later
 * wins: `config.json` defaults → its chain overlay → `secrets.json` defaults → its chain overlay →
 * the process env (so Railway's env-only deployment and ad-hoc shell overrides beat files) → the
 * resolved chain id. Chain resolution: `--chain` flag > `CHAIN_ID` env > the sole chain configured
 * across both files; anything else is a ConfigError (exit 2).
 */
export function mergedEnv(args: {
  home: string
  bot: BotName
  chain?: string | undefined
  processEnv?: Env
}): { env: Env; chainId: string } {
  const processEnv = args.processEnv ?? process.env
  const config = readSettings(configFile(args.home))
  const secrets = readSettings(secretsFile(args.home))
  const configured = new Set([
    ...Object.keys(config?.[args.bot]?.chains ?? {}),
    ...Object.keys(secrets?.[args.bot]?.chains ?? {})
  ])

  const chainId =
    args.chain ?? processEnv.CHAIN_ID ?? (configured.size === 1 ? [...configured][0] : undefined)
  if (!chainId) {
    throw new ConfigError(
      configured.size === 0
        ? `no chain configured for ${args.bot} — pass --chain, set CHAIN_ID, or add a chains section to ${configFile(args.home)}`
        : `multiple chains configured for ${args.bot} (${[...configured].join(', ')}) — pass --chain or set CHAIN_ID`
    )
  }

  const env: Env = {
    ...overlay(config?.[args.bot], chainId),
    ...overlay(secrets?.[args.bot], chainId),
    ...definedOnly(processEnv),
    CHAIN_ID: chainId
  }
  return { env, chainId }
}

/**
 * Builds the env-shaped table for the chain-less `signer` daemon. Sources, later wins:
 * `config.json` `signer.defaults` → `secrets.json` `signer.defaults` → the process env (so an
 * env-only deployment and ad-hoc shell overrides beat files). No chain resolution — one daemon
 * serves every chain, and the per-chain policy lives in the policy file, not env.
 */
export function mergedSignerEnv(args: { home: string; processEnv?: Env }): Env {
  const processEnv = args.processEnv ?? process.env
  const config = readSettings(configFile(args.home))
  const secrets = readSettings(secretsFile(args.home))
  return {
    ...config?.signer?.defaults,
    ...secrets?.signer?.defaults,
    ...definedOnly(processEnv)
  }
}
