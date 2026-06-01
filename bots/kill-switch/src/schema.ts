import type { Address } from 'viem'

import { addressSchema } from '@repo/utils'
import { z } from 'zod'

// Per-oracle config. Phase 1 locks only the fields that are settled across phases; the
// staleness/reference adapter fields stay loose until Phases 4/5 lock the vendor set
// (TIB-2026-05-14 Open Question 3). Keep this in sync with `oracleConfigSchema` below.
type OracleConfig = {
  morphoOracleAddress: Address
  stalenessSeconds: number
  deviationBps?: number
  stalenessAdapter?: string
  stalenessSpec?: unknown
  referenceAdapter?: string
  referenceSpec?: unknown
}

// Hand-written canonical config type. Operators fork `config.ts` (Phase 8) and author against
// this type; `KillSwitchBotConfigSchema` validates it at the runtime boundary. The two are kept
// in sync by a compile-time assertion in `test/schema.test.ts` (TIB Considered Alternative 8).
export type KillSwitchBotConfig = {
  signer: { privateKeyEnv: string }
  chain: {
    id: number
    rpc: { http: string[] }
    pollIntervalMs: number
    walletBalanceFloor: string
  }
  vault: { address: Address }
  oracleConfigs: OracleConfig[]
  dryRun: boolean
}

const oracleConfigSchema = z
  .object({
    morphoOracleAddress: addressSchema,
    stalenessSeconds: z.number().int().positive(),
    deviationBps: z.number().int().positive().optional(),
    stalenessAdapter: z.string().optional(),
    stalenessSpec: z.unknown().optional(),
    referenceAdapter: z.string().optional(),
    referenceSpec: z.unknown().optional()
  })
  .strict()

export const KillSwitchBotConfigSchema = z
  .object({
    signer: z.object({ privateKeyEnv: z.string().min(1) }).strict(),
    chain: z
      .object({
        id: z.number().int().positive(),
        // Phase 1 reads only the first endpoint; Phase 2 swaps to viem's `fallback` over the list.
        rpc: z.object({ http: z.array(z.string().url()).min(1) }).strict(),
        pollIntervalMs: z.number().int().positive(),
        // Native-token amount as a string; parsed to bigint by the Phase 7 balance-floor check.
        walletBalanceFloor: z.string().min(1)
      })
      .strict(),
    vault: z.object({ address: addressSchema }).strict(),
    oracleConfigs: z.array(oracleConfigSchema),
    dryRun: z.boolean()
  })
  .strict()

// Validates operator config at the boundary, failing loud (throws) on any violation.
export function validateConfig(raw: unknown): KillSwitchBotConfig {
  return KillSwitchBotConfigSchema.parse(raw)
}
