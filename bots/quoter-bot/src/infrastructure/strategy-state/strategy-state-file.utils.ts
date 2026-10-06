import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, isHex, size } from 'viem'

import { StrategyStateVersionError } from './strategy-state-version.error'

/** The only strategy state version this binary reads or writes, for both strategies. */
export const STRATEGY_STATE_VERSION = 7

/**
 * Resolves the directory holding every strategy's durable ownership state.
 * @param override - Isolated directory used by tests.
 * @returns The override, else `$XDG_STATE_HOME/morpho-quoter-bot` (defaulting to `~/.local/state`).
 */
export const strategyStateDirectory = (override?: string) =>
  override ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-quoter-bot')

/**
 * Parses a persisted 32-byte identifier into its canonical lowercase form.
 * @param value - Untrusted persisted value.
 * @param invalid - Builds the strategy's state error.
 * @returns The canonical lowercase identifier.
 * @throws The error built by `invalid` for anything other than a strict 32-byte hex string.
 */
export const canonicalBytes32 = (value: unknown, invalid: () => Error) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw invalid()
  }
  return bytesToHex(hexToBytes(value))
}

/**
 * Parses a persisted unsigned decimal string.
 * @param value - Untrusted persisted value.
 * @param invalid - Builds the strategy's state error.
 * @returns The parsed amount.
 * @throws The error built by `invalid` for a non-string, a sign, or a leading zero.
 */
export const canonicalUnsignedDecimal = (value: unknown, invalid: () => Error) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw invalid()
  return BigInt(value)
}

/**
 * Reads one strategy state file only when it is a regular file, owned by this user, and mode `0600`
 * or tighter.
 * @param path - State file to read.
 * @param parse - Validates the decoded JSON; anything it throws is replaced by `invalid()`.
 * @param invalid - Builds the strategy's state error.
 * @returns `undefined` when the file does not exist, else what `parse` returns.
 * @throws `StrategyStateVersionError` for a file of any other {@link STRATEGY_STATE_VERSION}, and
 * the error built by `invalid` for any other stat, permission, read, JSON, or `parse` failure.
 */
export const readStrategyStateFile = async <T>(
  path: string,
  parse: (value: Record<string, unknown>) => T,
  invalid: () => Error
): Promise<T | undefined> => {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw invalid()
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw invalid()
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw invalid()
  let value: Record<string, unknown>
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    throw invalid()
  }
  if (typeof value !== 'object' || value === null) throw invalid()
  if (value.version !== STRATEGY_STATE_VERSION) throw new StrategyStateVersionError()
  try {
    return parse(value)
  } catch {
    throw invalid()
  }
}

/**
 * Fails unless every state file in the directory is readable and of this version.
 * @param directory - Strategy state directory; defaults to {@link strategyStateDirectory}.
 * @returns Completion when the directory is missing or every state file carries
 * {@link STRATEGY_STATE_VERSION}.
 * @throws `StrategyStateVersionError` for an unreadable directory, or a state file under any key,
 * including one this version no longer derives, that is unreadable, malformed, or of another version.
 */
export const assertCurrentStrategyStates = async (directory = strategyStateDirectory()) => {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new StrategyStateVersionError()
  }
  for (const name of names) {
    if (!/^0x[0-9a-f]{64}\.json$/.test(name)) continue
    let state: { version?: unknown } | null
    try {
      state = JSON.parse(await readFile(join(directory, name), 'utf8')) as typeof state
    } catch {
      throw new StrategyStateVersionError()
    }
    if (state?.version !== STRATEGY_STATE_VERSION) throw new StrategyStateVersionError()
  }
}

/**
 * Atomically replaces one strategy state file with `state` serialized as JSON, mode `0600`.
 * @param directory - State directory, created mode `0700` when missing.
 * @param path - State file inside `directory`.
 * @param state - JSON-serializable state to persist.
 * @returns Completion once `path` holds the new state; a crash never leaves a partial file behind.
 */
export const writeStrategyStateFile = async (directory: string, path: string, state: unknown) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(state), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
