import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Validated at startup via t3-env — any missing/malformed variable throws before the app boots,
// matching the repo's fail-loud convention. Secrets are never stored here; they are read at point
// of use. Defaults to process.env (not Bun.env): vitest executes under Node where the Bun global
// does not exist, and under bun the two are equivalent.
export function loadEnv(runtimeEnv: Record<string, string | undefined> = process.env) {
  return createEnv({
    server: {
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
    },
    runtimeEnv,
    emptyStringAsUndefined: true
  })
}
