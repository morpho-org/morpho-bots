import type { BunPlugin } from 'bun'

// soltag is a build-time-only transform: its `sol``` tagged templates throw at runtime unless a
// bundler/loader plugin compiles them (via solc). unplugin's own bun adapter (`unplugin.bun()`) is
// unusable under bun — it returns `undefined` from `onLoad` for files it doesn't transform, which
// bun rejects ("Expected module mock to return an object"). So we drive soltag's exported core
// transform from a plugin object that matches every TS source under this bot (where soltag is a
// dependency — other workspaces don't use it), returning files unchanged when they hold no template
// to compile.
//
// This factory is the single source of the transform, shared by two consumers:
//   1. `soltag.preload.ts` → `Bun.plugin(soltagPlugin)` for the source-run/dev/test path (bunfig
//      `preload`), so `bun src/main.ts` and `bun test` compile the lens on the fly.
//   2. The `@repo/cli` `build` script → `Bun.build({ plugins: [soltagPlugin] })`, so the prod AOT
//      bundle bakes the compiled lens bytecode into `dist/main.js` — the same transform, no drift.
// The plugin self-scopes to THIS package's dir via `import.meta.dir`, so both cores' plugins can be
// registered together without stepping on each other.
//
// Two speedups matter for one-shot ticks, which pay this plugin on EVERY source-run spawn:
//   1. Files without a `sol\`` literal skip the transform entirely (it would parse them for nothing).
//   2. Compiled output is cached on disk keyed by a source + solc-options hash, so solc runs once per
//      lens edit, not once per tick. Entries are content-addressed, so stale ones are inert; `rm -rf
//      .soltag/cache` clears them. NOTE: a soltag upgrade that changes codegen without an options
//      change would reuse old entries — clear the cache when bumping soltag.
// The expensive `import('soltag/unplugin')` (which statically pulls in solc + typescript, ~0.44s) is
// deferred until a cache MISS, so a warm spawn never loads the compiler at all.

const BOT_DIR = import.meta.dir
const ESCAPED = BOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Matches `<bot>/**/*.{ts,tsx,mts,cts}`, excluding any nested node_modules.
const INCLUDE = new RegExp(`^${ESCAPED}/(?:(?!/node_modules/).)*\\.(?:m|c)?tsx?$`)

// Enable the optimizer — the lens's per-element computation has enough locals to hit
// "stack too deep" without it.
const SOLC_OPTIONS = { optimizer: { enabled: true, runs: 200 } }
const CACHE_DIR = `${BOT_DIR}/.soltag/cache`

/** The shared soltag loader plugin, self-scoped to this package's TS sources. */
export const soltagPlugin: BunPlugin = {
  name: 'soltag',
  setup(build) {
    build.onLoad({ filter: INCLUDE }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts'
      if (!source.includes('sol`')) return { contents: source, loader }

      const hash = new Bun.CryptoHasher('sha256')
        .update(source)
        .update(JSON.stringify(SOLC_OPTIONS))
        .digest('hex')
      const cached = Bun.file(`${CACHE_DIR}/${hash}.ts`)
      if (await cached.exists()) return { contents: await cached.text(), loader }

      // Cache miss only: pull in the compiler (solc + typescript) lazily, so warm spawns never do.
      const { transformSolTemplates } = await import('soltag/unplugin')
      const transformed = transformSolTemplates(source, path, { solc: SOLC_OPTIONS })
      const contents = transformed?.code ?? source
      await Bun.write(`${CACHE_DIR}/${hash}.ts`, contents)
      return { contents, loader }
    })
  }
}
