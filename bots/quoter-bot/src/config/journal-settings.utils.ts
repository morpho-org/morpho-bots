import { buildIdentityFromEnv, parseJournalRunCapBytes } from '@repo/kit'

import type { JournalSettings } from '../run'

import { ConfigValidationError } from '../errors'

type Environment = Record<string, string | undefined>

/** A run's journal file stops the bot cleanly at this size unless `JOURNAL_RUN_CAP_BYTES` says otherwise. */
const DEFAULT_JOURNAL_RUN_CAP_BYTES = 1024 ** 3

const set = (value: string | undefined) => (value?.trim() ? value : undefined)

/**
 * The journal's build identity and run cap. `BUILD_REVISION` and `BUILD_IMAGE_TAG` fall back to the
 * values the bundle was stamped with at build time, so an npm install names its release.
 * @param environment - The process environment the command runs with.
 * @returns What names the run's journal and the size at which it stops for a fresh one.
 * @throws `ConfigValidationError` when neither names the build, or the run cap is not a byte count.
 */
export const journalSettings = (environment: Environment): JournalSettings => {
  let build: JournalSettings['build']
  try {
    build = buildIdentityFromEnv({
      BUILD_REVISION: set(environment.BUILD_REVISION) ?? process.env.QUOTER_BOT_BUILD_REVISION,
      BUILD_IMAGE_TAG: set(environment.BUILD_IMAGE_TAG) ?? process.env.QUOTER_BOT_BUILD_IMAGE_TAG
    })
  } catch (error) {
    throw new ConfigValidationError('BUILD_REVISION', 'missing', (error as Error).message)
  }
  const cap = set(environment.JOURNAL_RUN_CAP_BYTES)
  if (cap === undefined) return { build, runCapBytes: DEFAULT_JOURNAL_RUN_CAP_BYTES }
  try {
    return { build, runCapBytes: parseJournalRunCapBytes(cap) }
  } catch (error) {
    throw new ConfigValidationError('JOURNAL_RUN_CAP_BYTES', 'invalid', (error as Error).message)
  }
}
