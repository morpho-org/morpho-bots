import { transformSolTemplates } from 'soltag/unplugin'

// soltag is a build-time-only transform: its `sol``` tagged templates throw at runtime unless a
// bundler/loader plugin compiles them (via solc). unplugin's own bun adapter (`unplugin.bun()`) is
// unusable under bun — it returns `undefined` from `onLoad` for files it doesn't transform, which
// bun rejects ("Expected module mock to return an object"). So we drive soltag's exported core
// transform from a bun loader plugin: it matches every TS source under this bot (where soltag is a
// dependency — other workspaces don't use it), and returns files unchanged when they hold no
// template to compile. Wired via bunfig `preload` for both `bun test` and `bun run`.

const BOT_DIR = import.meta.dir
const ESCAPED = BOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Matches `<bot>/**/*.{ts,tsx,mts,cts}`, excluding any nested node_modules.
const INCLUDE = new RegExp(`^${ESCAPED}/(?:(?!/node_modules/).)*\\.(?:m|c)?tsx?$`)

Bun.plugin({
  name: 'soltag',
  setup(build) {
    build.onLoad({ filter: INCLUDE }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts'
      // Enable the optimizer — the lens's per-element computation has enough locals to hit
      // "stack too deep" without it.
      const transformed = transformSolTemplates(source, path, {
        solc: { optimizer: { enabled: true, runs: 200 } }
      })
      return { contents: transformed?.code ?? source, loader }
    })
  }
})
