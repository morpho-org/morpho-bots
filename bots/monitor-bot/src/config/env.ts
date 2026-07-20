import type { Provider } from '@nestjs/common'
import type { Address } from 'viem'

import { createEnv } from '@t3-oss/env-core'
import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

export const ENV = Symbol('ENV')

const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/

function splitCsv(value: string) {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

const addressListSchema = z
  .string()
  .default('')
  .transform((value, ctx) => {
    const parts = splitCsv(value)
    const invalid = parts.filter(part => !isAddress(part))
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid address: ${invalid.join(', ')}`
      })
      return z.NEVER
    }
    return parts.filter((part): part is Address => isAddress(part)).map(part => getAddress(part))
  })

const marketIdListSchema = z
  .string()
  .default('')
  .transform((value, ctx) => {
    const parts = splitCsv(value)
    const invalid = parts.filter(part => !MARKET_ID_PATTERN.test(part))
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid market id: ${invalid.join(', ')}`
      })
      return z.NEVER
    }
    return parts
  })

// Cron validity is enforced fail-loud at registrar boot (CronJob construction throws).
const cronSchema = z.string().min(1)

const boolSchema = z.enum(['true', 'false']).transform(value => value === 'true')

// Validated at startup via t3-env — any missing/malformed variable throws before the app boots,
// matching the repo's fail-loud convention. Secrets are never stored here; they are read at point
// of use. Defaults to process.env (not Bun.env): vitest executes under Node where the Bun global
// does not exist, and under bun the two are equivalent.
export function loadEnv(runtimeEnv: Record<string, string | undefined> = process.env) {
  return createEnv({
    server: {
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      MIDNIGHT_API_URL: z.string().url().default('https://api.morpho.org'),
      /** Fixed market scope; empty = auto-discover all active markets. */
      MARKET_IDS: marketIdListSchema,
      /** Same name and unit as midnight-liquidation's market-refresh knob. */
      MARKETS_REFRESH_MS: z.coerce.number().int().min(1).default(600_000),
      /** Minimum attributed size (loan-token base units) for an alert; 0 = no size filter. */
      FILTER_MIN_ASSETS: z.string().regex(/^\d+$/).default('0').transform(BigInt),
      /** Position-owner allowlist; empty = all users. */
      FILTER_USERS: addressListSchema,
      POLL_CRON_TAKE_ORDERS: cronSchema.default('*/30 * * * * *'),
      POLL_CRON_REPAYS: cronSchema.default('*/30 * * * * *'),
      POLL_CRON_COLLATERAL: cronSchema.default('*/30 * * * * *'),
      POLL_CRON_LIQUIDATIONS: cronSchema.default('*/15 * * * * *'),
      /** Also treat exit_borrow_secondary (debt closed via trade) as a repay. */
      REPAYS_INCLUDE_SECONDARY: boolSchema.default('false'),
      /** Also alert on withdraw_collateral (borrower de-collateralizing — the risk signal). */
      COLLATERAL_INCLUDE_WITHDRAW: boolSchema.default('true'),
      POLL_CRON_MAKE_ORDERS: cronSchema.default('*/30 * * * * *'),
      /** Slack channel id for alerts; unset falls back to log-only dispatch. The bot token is a
       *  secret read at point of use (SLACK_BOT_TOKEN), never stored on this object. */
      SLACK_CHANNEL: z.string().min(1).optional()
    },
    runtimeEnv,
    emptyStringAsUndefined: true
  })
}

export type MonitorEnv = ReturnType<typeof loadEnv>

export const envProvider: Provider = { provide: ENV, useFactory: loadEnv }
