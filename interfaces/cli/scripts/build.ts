import { soltagPlugin as bluePlugin } from '@repo/blue-liquidation/soltag-plugin'
import { soltagPlugin as midnightPlugin } from '@repo/midnight-liquidation/soltag-plugin'

// The prod-only AOT bundle (see the pipeline TIB's "warm by construction"). `Bun.build` runs the two
// cores' soltag plugins — the SAME transform the source-run preload uses — so the compiled lens
// bytecode is baked into `dist/main.js` and prod spawns pay zero soltag/solc/transpile cost. Both
// plugins self-scope to their own package dir, so registering them together is safe. The plugins are
// imported via each core's `"./soltag-plugin"` subpath export (never a deep relative path). Dev/test
// stay source-run; the `bin` keeps pointing at `src/main.ts`. The Dockerfile wiring lands in PR4.

const result = await Bun.build({
  entrypoints: ['src/main.ts'],
  target: 'bun',
  outdir: 'dist',
  plugins: [bluePlugin, midnightPlugin]
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  // Fail loud: a bundler error must break the build layer, not ship a broken artifact.
  throw new AggregateError(result.logs, 'CLI build failed')
}

console.log(`built ${result.outputs.length} file(s) → dist/`)
