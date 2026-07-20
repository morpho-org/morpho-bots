import { fileURLToPath } from 'node:url'
import soltag from 'soltag/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const BOT_DIR = fileURLToPath(new URL('.', import.meta.url))

// soltag is a build-time-only transform: its `sol``` tagged templates throw at runtime unless a
// plugin compiles them (via solc). The vite plugin transforms this project's TS sources and leaves
// files without templates unchanged. Enable the optimizer — the lens's per-element computation has
// enough locals to hit "stack too deep" without it.
export default defineConfig({
  plugins: [soltag({ solc: { optimizer: { enabled: true, runs: 200 } } })],
  test: {
    name: 'midnight-liquidation',
    // The fork suite reads RPC_URL_8453 from .env.test.local (CI supplies it as a secret).
    env: loadEnv('test', BOT_DIR, '')
  }
})
