import type { Plugin } from 'esbuild'

import { build as esbuild } from 'esbuild'
import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSolTemplates } from 'soltag/unplugin'

import { BundleFailedError } from './bundle-failed.error'

// Bundles the bot entrypoint (and the soltag-dependent operator script) to `dist/` with the
// `sol``` templates compiled to literal ABIs/bytecode, so production runs a plain `node` with no
// runtime transform. This replaces the bunfig `preload` that used to compile them at startup.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

const ESCAPED = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// This bot's own TS sources only — bundled workspace deps ship prebuilt dist and hold no templates.
const INCLUDE = new RegExp(`^${ESCAPED}/(?:src|scripts)/.*\\.tsx?$`)

const soltagPlugin: Plugin = {
  name: 'soltag',
  setup(build) {
    build.onLoad({ filter: INCLUDE }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      // Enable the optimizer — the lens's per-element computation has enough locals to hit
      // "stack too deep" without it.
      const transformed = transformSolTemplates(source, path, {
        solc: { optimizer: { enabled: true, runs: 200 } }
      })
      return { contents: transformed?.code ?? source, loader: 'ts' as const }
    })
  }
}

try {
  await esbuild({
    entryPoints: [join(ROOT, 'src/index.ts'), join(ROOT, 'scripts/probe-live-lens.ts')],
    outdir: DIST_DIR,
    outbase: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // CJS deps reaching for require() inside an ESM bundle need a real require.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    plugins: [soltagPlugin]
  })
} catch (error) {
  throw new BundleFailedError(error instanceof Error ? error.message : String(error))
}
