import soltag from 'soltag/vite'
import { defineConfig } from 'vitest/config'

// soltag is a build-time-only transform: its `sol``` tagged templates throw at runtime unless a
// plugin compiles them (via solc). The vite plugin transforms this project's TS sources and leaves
// files without templates unchanged. Enable the optimizer: the lens's per-market loop has enough
// locals to hit "stack too deep" without it.
export default defineConfig({
  plugins: [soltag({ solc: { optimizer: { enabled: true, runs: 200 } } })],
  test: {
    name: 'vault-v1-reallocation'
  }
})
