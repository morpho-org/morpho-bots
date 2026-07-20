import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSolTemplates } from 'soltag/unplugin'

// Bundles `src/{index,v2/index}.ts` to `dist/` with the soltag `sol``` templates in `src/abis.ts`
// and `src/contracts.ts` compiled to literal ABIs (and, for contracts, bytecode + a deployless
// factory). The narrowed `.d.ts` is emitted separately by
// `tsc -p tsconfig.build.json --emitDeclarationOnly` (see the `build` script), which reads the
// `.soltag/types.d.ts` augmentation cache the `soltag` CLI writes first. The soltag onLoad plugin
// is the same transform the repo's vitest configs use, scoped here to this package's `src/` so
// bundled deps are untouched.

// This script lives in `scripts/`, so paths resolve against the package root one level up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DIST_DIR = join(ROOT, 'dist')
// Clean first so renamed/removed sources don't leave stale `dist/*.{js,d.ts}` behind (the `tsc`
// pass that follows reuses this dir).
rmSync(DIST_DIR, { recursive: true, force: true })

const SRC_DIR = join(ROOT, 'src')
const ESCAPED = SRC_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const INCLUDE = new RegExp(`^${ESCAPED}/.*\\.tsx?$`)

await build({
  entryPoints: [join(SRC_DIR, 'index.ts')],
  outdir: DIST_DIR,
  outbase: SRC_DIR,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'soltag-contracts',
      setup(build) {
        build.onLoad({ filter: INCLUDE }, async ({ path }) => {
          const source = await readFile(path, 'utf8')
          const transformed = transformSolTemplates(source, path, {
            solc: { optimizer: { enabled: true, runs: 200 } }
          })
          return { contents: transformed?.code ?? source, loader: 'ts' }
        })
      }
    }
  ]
})

// Emit each interface ABI as JSON under `abis/`, for tools that need ABIs on disk rather than the
// TS `as const` exports (e.g. rindexer, which the midnight-liquidation image feeds from here). The
// ABIs are materialized in the freshly-bundled `dist/index.js` above, so we read them back from it.
// Interface exports are named `<Name>Abi` and hold the ABI array (contract exports are objects and
// are skipped). Gitignored build output, like `dist/`.
const ABIS_DIR = join(ROOT, 'abis')
rmSync(ABIS_DIR, { recursive: true, force: true })
mkdirSync(ABIS_DIR, { recursive: true })

const bundled = (await import(join(DIST_DIR, 'index.js'))) as Record<string, unknown>
let abiCount = 0
for (const [name, value] of Object.entries(bundled)) {
  if (!name.endsWith('Abi') || !Array.isArray(value)) continue
  const contract = name.slice(0, -'Abi'.length) // `MidnightAbi` -> `Midnight`
  writeFileSync(join(ABIS_DIR, `${contract}.json`), `${JSON.stringify(value, null, 2)}\n`)
  abiCount++
}
console.log(`[build] wrote ${abiCount} ABI JSON file(s) to abis/`)
