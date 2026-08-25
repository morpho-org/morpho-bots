import { NpmPackFailedError } from './npm-pack-failed.error'

/** Published npm package name; deliberately shorter than the workspace package name. */
export const NPM_PACKAGE_NAME = '@morpho-org/quoter'

/** Command name the published package installs on the consumer's PATH. */
export const NPM_BIN_NAME = 'morpho-quoter'

/** Bundle filename inside the staged package; the manifest's only shipped code file. */
export const NPM_BUNDLE_FILENAME = `${NPM_BIN_NAME}.js`

/** Shebang the staged bundle must open with so npm bin installation produces a runnable command. */
const NPM_BUNDLE_SHEBANG = '#!/usr/bin/env node\n'

/**
 * Release or prerelease semver without build metadata, e.g. `1.2.3` or `1.2.3-rc.1`. Per the
 * SemVer grammar, numeric identifiers must not carry leading zeroes (npm rejects `01.2.3` and
 * `1.2.3-01` at publish time, so staging rejects them too).
 */
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

/**
 * Validates the workspace manifest version that stamps the published package.
 * @param version - Candidate version, usually `package.json#version`.
 * @returns The validated version, unchanged.
 * @throws NpmPackFailedError when the version is missing or is not plain (pre)release semver.
 */
export const assertPublishableVersion = (version: unknown): string => {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new NpmPackFailedError(
      'package.json#version must be plain semver (for example 0.1.0) to stage the npm package'
    )
  }
  return version
}

/**
 * Validates that the built bundle can serve as the published npm `bin` entry.
 * @param source - Complete bundle source text.
 * @returns The validated source, unchanged.
 * @throws NpmPackFailedError when the bundle does not open with the required shebang line.
 */
export const assertBinBundle = (source: string): string => {
  if (!source.startsWith(NPM_BUNDLE_SHEBANG)) {
    throw new NpmPackFailedError(
      'bundle must start with the `#!/usr/bin/env node` shebang; rebuild with scripts/build.ts'
    )
  }
  return source
}

/**
 * Builds the manifest of the published npm package.
 * @param version - Validated release version to publish.
 * @returns A complete, dependency-free `package.json` object for the staged package.
 * @remarks The bundle is self-contained, so the manifest deliberately declares no dependencies —
 * a global install ships one file. `repository.url` must exactly match the GitHub repository for
 * npm provenance attestation, and `publishConfig.access` makes the scoped package public.
 */
export const buildNpmPackageManifest = (version: string) => ({
  name: NPM_PACKAGE_NAME,
  version,
  description:
    'Morpho Midnight quoter CLI: setup checks, position bootstrap, ladder quoting, and combined monitoring for maker operators.',
  license: 'Apache-2.0',
  type: 'module' as const,
  bin: { [NPM_BIN_NAME]: `./${NPM_BUNDLE_FILENAME}` },
  files: [NPM_BUNDLE_FILENAME],
  engines: { node: '>=24.14.1' },
  repository: {
    type: 'git' as const,
    url: 'git+https://github.com/morpho-org/morpho-bots.git',
    directory: 'bots/quoter-bot'
  },
  homepage: 'https://github.com/morpho-org/morpho-bots/tree/main/bots/quoter-bot#readme',
  bugs: 'https://github.com/morpho-org/morpho-bots/issues',
  keywords: ['morpho', 'midnight', 'quoter', 'market-maker', 'cli', 'base'],
  publishConfig: { access: 'public' as const }
})
