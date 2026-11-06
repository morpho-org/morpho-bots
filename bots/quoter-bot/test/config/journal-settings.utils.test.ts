import { afterEach, describe, expect, test, vi } from 'vitest'

import { journalSettings } from '../../src/config/journal-settings.utils'
import { ConfigValidationError } from '../../src/errors'

const build = { BUILD_REVISION: 'abcdef0123456789', BUILD_IMAGE_TAG: 'quoter-bot-1.0.0' }

describe('journalSettings', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('caps a run at 1 GiB unless JOURNAL_RUN_CAP_BYTES says otherwise', () => {
    expect(journalSettings(build)).toEqual({
      build: { revision: build.BUILD_REVISION, imageTag: build.BUILD_IMAGE_TAG },
      runCapBytes: 1024 ** 3
    })
    expect(journalSettings({ ...build, JOURNAL_RUN_CAP_BYTES: ' ' }).runCapBytes).toBe(1024 ** 3)
    expect(journalSettings({ ...build, JOURNAL_RUN_CAP_BYTES: '134217728' }).runCapBytes).toBe(
      134_217_728
    )
  })

  test.each(['1024', '1.5e9', 'lots'])('refuses JOURNAL_RUN_CAP_BYTES=%s', value => {
    expect(() => journalSettings({ ...build, JOURNAL_RUN_CAP_BYTES: value })).toThrow(
      expect.objectContaining({ name: 'ConfigValidationError', field: 'JOURNAL_RUN_CAP_BYTES' })
    )
  })

  test('falls back to the stamped build, and the environment overrides it', () => {
    vi.stubEnv('QUOTER_BOT_BUILD_REVISION', '0123456789abcdef')
    vi.stubEnv('QUOTER_BOT_BUILD_IMAGE_TAG', 'stamped')
    expect(journalSettings({}).build).toEqual({ revision: '0123456789abcdef', imageTag: 'stamped' })
    expect(journalSettings(build).build).toEqual({
      revision: build.BUILD_REVISION,
      imageTag: build.BUILD_IMAGE_TAG
    })
  })

  test('refuses to start when nothing names the build', () => {
    vi.stubEnv('QUOTER_BOT_BUILD_REVISION', '')
    vi.stubEnv('QUOTER_BOT_BUILD_IMAGE_TAG', '')
    expect(() => journalSettings({})).toThrow(ConfigValidationError)
    expect(() => journalSettings({ BUILD_REVISION: 'not-a-commit', BUILD_IMAGE_TAG: 'x' })).toThrow(
      expect.objectContaining({ field: 'BUILD_REVISION' })
    )
  })
})
