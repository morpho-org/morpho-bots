import type { z } from 'zod'

import { describe, expect, it } from 'bun:test'

import type { KillSwitchBotConfig } from '../src/schema'

import { KillSwitchBotConfigSchema, validateConfig } from '../src/schema'
import { config } from './fixtures/config'

// Compile-time guard: the hand-written `KillSwitchBotConfig` and the Zod schema must stay assignable
// both directions (TIB Considered Alternative 8). Enforced by the Typecheck CI job — `bun test` does
// not typecheck, so this never runs as a test; it goes red under `tsc` if the two drift apart.
type Inferred = z.infer<typeof KillSwitchBotConfigSchema>
type AssignableBothWays<A, B> = A extends B ? (B extends A ? true : false) : false
const _configSchemaInSync: AssignableBothWays<KillSwitchBotConfig, Inferred> = true
void _configSchemaInSync

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateConfig(config)).not.toThrow()
  })

  it('rejects an invalid oracle address (addressSchema is wired, not a bare string)', () => {
    const bad = {
      ...config,
      oracleConfigs: [{ ...config.oracleConfigs[0]!, morphoOracleAddress: '0xnope' }]
    }
    expect(() => validateConfig(bad)).toThrow()
  })

  it('rejects a config missing a required field', () => {
    const incomplete: Partial<KillSwitchBotConfig> = structuredClone(config)
    delete incomplete.dryRun
    expect(() => validateConfig(incomplete)).toThrow()
  })

  it('rejects an unknown top-level key (schema is strict)', () => {
    expect(() => validateConfig({ ...config, bogus: true })).toThrow()
  })
})
