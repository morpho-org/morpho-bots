import { describe, expect, test } from 'bun:test'

import packageJson from '../../package.json' with { type: 'json' }
import { VersionService } from '../../src/application/version.service'

describe('VersionService', () => {
  test('returns the package.json version the release tags are cut from', () => {
    expect(new VersionService().getVersion()).toBe(packageJson.version)
  })
})
