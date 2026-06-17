import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { transformSolTemplates } from 'soltag/unplugin'

// Bundles `src/{index,v2/index}.ts` to `dist/` with the soltag `sol``` templates in `src/abis.ts`
// and `src/contracts.ts` compiled to literal ABIs (and, for contracts, bytecode + a deployless
// factory). The narrowed `.d.ts` is emitted separately by
// `tsc -p tsconfig.build.json --emitDeclarationOnly` (see the `build` script), which reads the
// `.soltag/types.d.ts` augmentation cache the `soltag` CLI writes first. We bundle (rather than
// shell out to tsdown) to stay bun-native; the soltag onLoad plugin is the same transform the
// repo's preloads use, scoped here to this package's `src/` so bundled deps are untouched.

const DIST_DIR = join(import.meta.dir, 'dist')
// Clean first so renamed/removed sources don't leave stale `dist/*.{js,d.ts}` behind (the `tsc`
// pass that follows reuses this dir).
rmSync(DIST_DIR, { recursive: true, force: true })

const SRC_DIR = join(import.meta.dir, 'src')
const ESCAPED = SRC_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const INCLUDE = new RegExp(`^${ESCAPED}/.*\\.tsx?$`)

const result = await Bun.build({
  entrypoints: [join(SRC_DIR, 'index.ts')],
  outdir: DIST_DIR,
  root: SRC_DIR,
  target: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'soltag-contracts',
      setup(build) {
        build.onLoad({ filter: INCLUDE }, async ({ path }) => {
          const source = await Bun.file(path).text()
          const transformed = transformSolTemplates(source, path, {
            solc: { optimizer: { enabled: true, runs: 200 } }
          })
          return { contents: transformed?.code ?? source, loader: 'ts' }
        })
      }
    }
  ]
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
