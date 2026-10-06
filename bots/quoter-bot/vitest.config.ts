import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const BOT_DIR = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    name: 'quoter-bot',
    include: ['test/**/*.test.ts'],
    // Several cases here spawn the CLI as a real subprocess through tsx. A tsx cold start is ~1.3s
    // against bun's ~0.1s, and with projects running in parallel the slowest of them exceeded the 5s
    // default under CPU contention. The subprocess work is genuinely slower now, so the ceiling is
    // raised rather than the parallelism reduced.
    testTimeout: 30_000,
    // The e2e suite forks Base and reads RPC_URL_8453; see the liquidation bots' configs for why
    // loadEnv is safe when the file is absent.
    env: loadEnv('test', BOT_DIR, '')
  }
})
