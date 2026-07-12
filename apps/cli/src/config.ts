import type { BotName, BotSection } from '@repo/home'

import { ConfigError, configFile, readSettings, secretsFile } from '@repo/home'

type Env = Record<string, string | undefined>

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
