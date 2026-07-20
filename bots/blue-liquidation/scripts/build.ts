import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSolTemplates } from 'soltag/unplugin'

// Bundles the bot entrypoint (and the soltag-dependent operator script) to `dist/` with the
// `sol```` templates compiled to literal ABIs/bytecode — production runs `node dist/src/index.js`
// with no runtime transform. Same esbuild+soltag setup as @repo/contracts' build script.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')
rmSync(DIST_DIR, { recursive: true, force: true })

const ESCAPED = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// This bot's own TS sources only (bundled workspace deps ship prebuilt dist and hold no templates).
const INCLUDE = new RegExp(`^${ESCAPED}/(?:src|scripts)/.*\\.tsx?$`)

await build({
  entryPoints: [join(ROOT, 'src/index.ts'), join(ROOT, 'scripts/probe-live-lens.ts')],
  outdir: DIST_DIR,
  outbase: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // CJS deps reaching for require() inside the ESM bundle need a real require.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  },
  plugins: [
    {
      name: 'soltag',
      setup(build) {
        build.onLoad({ filter: INCLUDE }, async ({ path }) => {
          const source = await readFile(path, 'utf8')
          // Enable the optimizer — the lens's per-element computation has enough locals to hit
          // "stack too deep" without it.
          const transformed = transformSolTemplates(source, path, {
            solc: { optimizer: { enabled: true, runs: 200 } }
          })
          return { contents: transformed?.code ?? source, loader: 'ts' }
        })
      }
    }
  ]
})
