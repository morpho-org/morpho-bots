import { describe, expect, test } from 'vitest'

import { SemverPrecedenceError } from '../../scripts/semver-precedence.error'
import { comparePrecedence } from '../../scripts/semver-precedence.mjs'

describe('comparePrecedence', () => {
  test.each([
    ['core versions numerically', '1.9.0', '1.10.0'],
    ['prerelease before its release', '1.0.0-rc.1', '1.0.0'],
    ['numeric prerelease identifiers numerically', '1.0.0-rc.2', '1.0.0-rc.10'],
    ['numeric identifiers below alphanumeric ones', '1.0.0-1', '1.0.0-alpha'],
    ['alphanumeric identifiers lexically', '1.0.0-alpha', '1.0.0-beta'],
    ['fewer identifiers below a prefixed longer set', '1.0.0-alpha', '1.0.0-alpha.1'],
    ['the semver.org example chain start', '1.0.0-alpha.beta', '1.0.0-beta.2']
  ])('orders %s', (_name, lower, higher) => {
    expect(comparePrecedence(lower, higher)).toBe('ascending')
    expect(comparePrecedence(higher, lower)).toBe('descending')
  })

  test('orders nonnumeric prerelease identifiers lexically where sort -V would not', () => {
    // GNU sort -V natural-sorts alpha10 above alpha2; SemVer compares the identifiers as ASCII
    // strings, so alpha10 must precede alpha2.
    expect(comparePrecedence('1.0.0-alpha10', '1.0.0-alpha2')).toBe('ascending')
    expect(comparePrecedence('1.0.0-alpha2', '1.0.0-alpha10')).toBe('descending')
  })

  test.each([
    ['1.2.3', '1.2.3'],
    ['1.0.0-rc.1', '1.0.0-rc.1']
  ])('reports %s equal to itself', (left, right) => {
    expect(comparePrecedence(left, right)).toBe('equal')
  })

  test.each([
    ['empty', ''],
    ['prefixed', 'v1.2.3'],
    ['build metadata', '1.2.3+build'],
    ['leading-zero core', '01.2.3'],
    ['leading-zero numeric prerelease', '1.2.3-01']
  ])('rejects %s versions', (_name, malformed) => {
    expect(() => comparePrecedence(malformed, '1.2.3')).toThrow(SemverPrecedenceError)
    expect(() => comparePrecedence('1.2.3', malformed)).toThrow(SemverPrecedenceError)
  })
})
