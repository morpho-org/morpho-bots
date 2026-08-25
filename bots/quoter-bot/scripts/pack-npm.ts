import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NpmPackFailedError } from './npm-pack-failed.error'
import {
  assertBinBundle,
  assertPublishableVersion,
  buildNpmPackageManifest,
  NPM_BUNDLE_FILENAME,
  NPM_PACKAGE_NAME
} from './npm-package.utils'

// Stages the publishable npm package under `dist/npm/`: the self-contained bundle renamed to the
// bin filename, a generated dependency-free manifest, the repository LICENSE, and the CLI-focused
// README. `npm publish` runs against that directory (see
// .github/workflows/publish-quoter-bot-npm.yml), so the workspace manifest — with its
// workspace/catalog specifiers and private flag — never reaches the registry.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ROOT, '..', '..')
const BUNDLE_PATH = join(ROOT, 'dist', 'src', 'index.js')
const STAGE_DIR = join(ROOT, 'dist', 'npm')

const readRequired = (path: string, missingHint: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new NpmPackFailedError(missingHint)
  }
}

const workspaceManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version?: string
}
const version = assertPublishableVersion(workspaceManifest.version)
const bundle = assertBinBundle(
  readRequired(
    BUNDLE_PATH,
    'bundle missing; run `pnpm --filter @morpho-org/quoter-bot run build` first'
  )
)
const license = readRequired(join(REPO_ROOT, 'LICENSE'), 'repository LICENSE file is missing')
const readme = readRequired(
  join(ROOT, 'docs', 'npm-README.md'),
  'docs/npm-README.md is missing; it ships as the published package README'
)

rmSync(STAGE_DIR, { recursive: true, force: true })
mkdirSync(STAGE_DIR, { recursive: true })
const bundlePath = join(STAGE_DIR, NPM_BUNDLE_FILENAME)
writeFileSync(bundlePath, bundle)
chmodSync(bundlePath, 0o755)
writeFileSync(join(STAGE_DIR, 'LICENSE'), license)
writeFileSync(join(STAGE_DIR, 'README.md'), readme)
writeFileSync(
  join(STAGE_DIR, 'package.json'),
  `${JSON.stringify(buildNpmPackageManifest(version), null, 2)}\n`
)

console.log(`Staged ${NPM_PACKAGE_NAME}@${version} at ${STAGE_DIR}`)
console.log(`Verify with: node ${join(STAGE_DIR, NPM_BUNDLE_FILENAME)} --version`)
