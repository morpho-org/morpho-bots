import type { Address } from 'viem'

import { addressSchema } from './schema'

/** The file-merged env table every stage config is parsed from. */
export type Env = Record<string, string | undefined>

/** Reads a required env var, failing loud if it is missing or blank. */
export function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

/** Parses an optional non-negative integer env var, with a default and optional min/max bounds. */
export function intEnv(
  env: Env,
  name: string,
  def: number,
  bounds: { min?: number; max?: number } = {}
): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${name} must be <= ${bounds.max}, got: ${env[name]}`)
  }
  return value
}

/**
 * Parses an optional positive decimal env var, with a default and optional min bound. Decimal form
 * only — rejects hex/exponent so it agrees with the integer validator.
 */
export function numberEnv(
  env: Env,
  name: string,
  def: number,
  bounds: { min?: number } = {}
): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive number, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  return value
}

/**
 * Parses an optional boolean env var (`true`/`false`, case-insensitive), with a default. Any other
 * non-empty value is operator error and fails loud.
 */
export function boolEnv(env: Env, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return def
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${name} must be "true" or "false", got: ${env[name]}`)
  }
  return raw === 'true'
}

/**
 * Parses an optional comma-separated list of positive decimals into raw string tokens, with a
 * default. Fails loud on any empty/non-positive/malformed element rather than silently dropping it.
 * Strings are kept raw so callers can convert them losslessly (e.g. `safeParseUnits` per-unit).
 */
export function ladderEnv(env: Env, name: string, def: string[]): string[] {
  const raw = env[name]?.trim()
  if (!raw) return def
  const sizes = raw.split(',').map(part => part.trim())
  for (const size of sizes) {
    if (!/^\d+(\.\d+)?$/.test(size) || Number(size) <= 0) {
      throw new Error(`${name} must be comma-separated positive numbers, got: ${env[name]}`)
    }
  }
  return sizes
}

/**
 * Parses an optional comma-separated list of addresses into checksummed `Address`es, with `[]` as the
 * default. Fails loud on any malformed element (operator error).
 */
export function addressListEnv(env: Env, name: string): Address[] {
  const raw = env[name]?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const parsed = addressSchema.safeParse(part)
      if (!parsed.success) {
        throw new Error(`${name} contains an invalid address: ${part}`)
      }
      return parsed.data
    })
}

/**
 * The operator EOA a liquidate transform targets (`LIQUIDATOR_ADDRESS`): required (no derivable
 * default — the transform has no key), checksum-normalized, fail-loud on a malformed value.
 */
export function resolveLiquidatorAddress(env: Env): Address {
  const raw = required(env, 'LIQUIDATOR_ADDRESS').trim()
  const parsed = addressSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`LIQUIDATOR_ADDRESS is not a valid address: ${raw}`)
  }
  return parsed.data
}
