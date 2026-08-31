import { build as esbuild } from 'esbuild'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BundleFailedError } from './bundle-failed.error'

// Bundles the Lambda handler to `dist/index.mjs`. The `.mjs` extension is load-bearing: the AWS
// Lambda Node.js managed runtime resolves the `index.handler` handler string to `index.mjs` and
// loads it as ESM without a package.json riding along in the image.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

try {
  await esbuild({
    entryPoints: [join(ROOT, 'src/index.ts')],
    outfile: join(DIST_DIR, 'index.mjs'),
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
