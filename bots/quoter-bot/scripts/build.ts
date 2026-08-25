import { build as esbuild } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BundleFailedError } from './bundle-failed.error'

// Bundles the bot entrypoint to `dist/` so production runs a plain `node` with no TypeScript
// transform at startup. This bot holds no soltag `sol``` templates, so no transform plugin is wired.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

let manifest: { version?: string }
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
} catch {
  throw new BundleFailedError('package.json could not be read or parsed for version stamping')
}

try {
  await esbuild({
    entryPoints: [join(ROOT, 'src/index.ts')],
    outdir: DIST_DIR,
    outbase: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // The bundle doubles as the published npm `bin`, so it must open with a shebang; node ignores
    // the line when the bundle is run as `node dist/src/index.js`. CJS deps reaching for require()
    // inside an ESM bundle need a real require.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    // Stamp the release version into VersionService so built artifacts report their real version.
    define: {
      'process.env.QUOTER_BOT_VERSION': JSON.stringify(manifest.version ?? '0.0.0')
    }
  })
} catch (error) {
  throw new BundleFailedError(error instanceof Error ? error.message : String(error))
}
