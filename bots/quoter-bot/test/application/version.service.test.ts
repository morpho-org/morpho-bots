import { describe, expect, test } from 'vitest'

import { VersionService } from '../../src/application/version.service'

describe('VersionService', () => {
  test('returns the hardcoded bot version', () => {
    expect(new VersionService().getVersion()).toBe('0.0.0')
  })
})
