import { build as esbuild } from 'esbuild'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BundleFailedError } from './bundle-failed.error'

// Bundles the bot entrypoint to `dist/` so production runs a plain `node` with no runtime transform.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

try {
  await esbuild({
    entryPoints: [join(ROOT, 'src/index.ts')],
    outdir: DIST_DIR,
    outbase: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // CJS deps reaching for require() inside an ESM bundle need a real require.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    }
  })
} catch (error) {
  throw new BundleFailedError(error instanceof Error ? error.message : String(error))
}
