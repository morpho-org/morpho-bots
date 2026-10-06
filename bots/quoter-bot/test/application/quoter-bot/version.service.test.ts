import { describe, expect, test } from 'vitest'

import { VersionService } from '../../../src/application/quoter-bot/version.service'

describe('VersionService', () => {
  test('returns the dev placeholder when no build-injected version is present', () => {
    expect(new VersionService().getVersion()).toBe('0.0.0-dev')
  })
})
