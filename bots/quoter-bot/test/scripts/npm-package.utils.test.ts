import { describe, expect, test } from 'vitest'

import { NpmPackFailedError } from '../../scripts/npm-pack-failed.error'
import {
  assertBinBundle,
  assertPublishableVersion,
  buildNpmPackageManifest,
  NPM_BIN_NAME,
  NPM_BUNDLE_FILENAME,
  NPM_PACKAGE_NAME
} from '../../scripts/npm-package.utils'

describe('assertPublishableVersion', () => {
  test.each([['0.1.0'], ['1.2.3'], ['10.20.30'], ['1.2.3-rc.1'], ['1.2.3-beta-4.5']])(
    'accepts plain (pre)release semver %s',
    version => {
      expect(assertPublishableVersion(version)).toBe(version)
    }
  )

  test.each([
    ['missing', undefined],
    ['non-string', 123],
    ['empty', ''],
    ['prefixed', 'v1.2.3'],
    ['incomplete', '1.2'],
    ['build metadata', '1.2.3+build.7'],
    ['surrounding whitespace', ' 1.2.3'],
    ['range', '^1.2.3']
  ])('rejects %s versions', (_name, version) => {
    expect(() => assertPublishableVersion(version)).toThrow(NpmPackFailedError)
  })
})

describe('assertBinBundle', () => {
  test('accepts a bundle opening with the node shebang', () => {
    const source = '#!/usr/bin/env node\nconsole.log(1)\n'
    expect(assertBinBundle(source)).toBe(source)
  })

  test.each([
    ['shebang missing', 'console.log(1)\n'],
    ['shebang not first', '\n#!/usr/bin/env node\n'],
    ['wrong interpreter', '#!/bin/sh\n']
  ])('rejects a bundle with %s', (_name, source) => {
    expect(() => assertBinBundle(source)).toThrow(NpmPackFailedError)
  })
})

describe('buildNpmPackageManifest', () => {
  const manifest = buildNpmPackageManifest('0.1.0')

  test('publishes the CLI package name, version, and bin command', () => {
    expect(manifest.name).toBe(NPM_PACKAGE_NAME)
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.bin).toEqual({ [NPM_BIN_NAME]: `./${NPM_BUNDLE_FILENAME}` })
    expect(manifest.files).toEqual([NPM_BUNDLE_FILENAME])
    expect(manifest.type).toBe('module')
  })

  test('stays dependency-free and never marks the package private', () => {
    expect(Object.keys(manifest)).not.toContain('dependencies')
    expect(Object.keys(manifest)).not.toContain('devDependencies')
    expect(Object.keys(manifest)).not.toContain('private')
  })

  test('carries the provenance-matching repository and public access', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/morpho-org/morpho-bots.git',
      directory: 'bots/quoter-bot'
    })
    expect(manifest.publishConfig).toEqual({ access: 'public' })
    expect(manifest.license).toBe('Apache-2.0')
  })
})
