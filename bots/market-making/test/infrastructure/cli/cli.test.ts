import { describe, expect, test } from 'bun:test'

import { VersionService } from '../../../src/application/version.service'
import { Cli } from '../../../src/infrastructure/cli/cli'

describe('Cli', () => {
  test('mm --version returns 0.0.0', () => {
    expect(new Cli(new VersionService()).run(['--version'])).toBe('0.0.0')
  })

  test('mm -v is an alias for --version', () => {
    expect(new Cli(new VersionService()).run(['-v'])).toBe('0.0.0')
  })

  test('rejects an unknown command', () => {
    expect(() => new Cli(new VersionService()).run(['bogus'])).toThrow(/too many arguments/)
  })

  test('rejects an empty argv', () => {
    expect(() => new Cli(new VersionService()).run([])).toThrow('Unknown command: (none)')
  })
})
