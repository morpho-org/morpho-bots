import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { StrategyStateVersionError } from '../../errors'

/** Ownership state an earlier, pre-kernel version wrote, one file per strategy. */
const LEGACY_STATE_FILE = /^0x[0-9a-f]{64}\.json$/

/**
 * Resolves the directory holding the kernel ledgers.
 * @param override - Isolated directory used by tests.
 * @returns The override, else `$XDG_STATE_HOME/morpho-quoter-bot` (defaulting to `~/.local/state`).
 */
export const strategyStateDirectory = (override?: string) =>
  override ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-quoter-bot')

/**
 * Refuses to start beside ownership state an earlier version wrote, whose groups no kernel owns.
 * @param directory - State directory; defaults to {@link strategyStateDirectory}.
 * @throws `StrategyStateVersionError` when the directory is unreadable or holds a legacy file.
 */
export const assertNoLegacyStrategyState = async (directory = strategyStateDirectory()) => {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new StrategyStateVersionError()
  }
  if (names.some(name => LEGACY_STATE_FILE.test(name))) throw new StrategyStateVersionError()
}
