import { soltagPlugin } from './soltag.plugin'

// Registers the shared soltag loader plugin (see soltag.plugin.ts) for the source-run/dev/test path,
// wired via bunfig `preload` for both `bun test` and `bun run`. The prod AOT `build` script feeds the
// same `soltagPlugin` to `Bun.build`, so runtime preload and the bundler share one transform.
void Bun.plugin(soltagPlugin)
