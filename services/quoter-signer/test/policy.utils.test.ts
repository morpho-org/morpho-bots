import { describe, expect, it } from 'vitest'

import type { PolicyConfigurationReason } from '../src/policy-not-configured.error'

import { PolicyNotConfiguredError } from '../src/policy-not-configured.error'
import {
  emergencyBump,
  parseQuoterSignerPolicy,
  QUOTER_SIGNER_POLICY_VERSION,
  RATIFIER_MODES,
  SIGNING_SURFACES
} from '../src/policy.utils'
import {
  FIXTURE_MAKER as maker,
  FIXTURE_MEMPOOL,
  FIXTURE_MIDNIGHT,
  FIXTURE_RATIFIER as ratifier,
  fixtureCollateral,
  fixtureMarketEntry,
  fixturePolicyDocument,
  fixtureProtectedCeiling as protectedCeiling,
  fixtureRoutineCeiling as routineCeiling
} from './policy-fixture'

const bytes32 = (byte: string) => `0x${byte.repeat(32)}` as const

const market = (overrides: Record<string, unknown> = {}) => fixtureMarketEntry({}, overrides)

const document = (overrides: Record<string, unknown> = {}) =>
  fixturePolicyDocument({
    policyVersion: QUOTER_SIGNER_POLICY_VERSION,
    surface: 'quote',
    ratifierMode: 'ecrecover',
    ...overrides
  })

const expectNotConfigured = (
  source: string | undefined,
  field: string,
  reason: PolicyConfigurationReason
) => {
  let caught: unknown
  try {
    parseQuoterSignerPolicy(source)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PolicyNotConfiguredError)
  expect(caught).toMatchObject({ field, reason, retryable: false })
}

describe('emergencyBump', () => {
  it.each<[bigint, bigint]>([
    [0n, 1n],
    [1n, 2n],
    [8n, 9n],
    [1000n, 1125n],
    [3000000000n, 3375000000n]
  ])('bumps %s to max(floor(x * 1125 / 1000), x + 1) = %s', (ceiling, bumped) => {
    expect(emergencyBump(ceiling)).toBe(bumped)
  })
})

describe('parseQuoterSignerPolicy', () => {
  it('round-trips a complete policy document and checksums addresses', () => {
    const parsed = parseQuoterSignerPolicy(
      JSON.stringify(document({ maker: maker.toLowerCase(), ratifier: ratifier.toLowerCase() }))
    )
    expect(parsed).toStrictEqual(document())
  })

  it.each(SIGNING_SURFACES)('accepts the %s surface with a compatible mode', surface => {
    const ratifierMode = surface === 'ratify' ? 'setter' : 'ecrecover'
    const parsed = parseQuoterSignerPolicy(JSON.stringify(document({ surface, ratifierMode })))
    expect(parsed.surface).toBe(surface)
  })

  it.each(RATIFIER_MODES)('accepts the %s mode on a mode-agnostic surface', ratifierMode => {
    const parsed = parseQuoterSignerPolicy(
      JSON.stringify(document({ surface: 'routine-revoke', ratifierMode }))
    )
    expect(parsed.ratifierMode).toBe(ratifierMode)
  })

  it('accepts an empty remediation manifest on non-remediation deployments', () => {
    const parsed = parseQuoterSignerPolicy(JSON.stringify(document({ remediations: [] })))
    expect(parsed.remediations).toStrictEqual([])
  })

  it('accepts protected ceilings covering exactly one emergency bump', () => {
    const parsed = parseQuoterSignerPolicy(
      JSON.stringify(
        document({
          feeCeilings: {
            routine: routineCeiling,
            protected: {
              maxFeePerGas: '3375000000',
              maxPriorityFeePerGas: '1687500000',
              gas: routineCeiling.gas
            }
          }
        })
      )
    )
    expect(parsed.feeCeilings.protected.maxFeePerGas).toBe('3375000000')
  })

  it.each<[string, string | undefined, string, PolicyConfigurationReason]>([
    ['an unset variable', undefined, 'QUOTER_SIGNER_POLICY', 'missing'],
    ['a blank variable', '   ', 'QUOTER_SIGNER_POLICY', 'missing'],
    ['malformed JSON', '{policy', 'QUOTER_SIGNER_POLICY', 'not-json'],
    ['a non-object document', '"quote"', 'policy', 'not-an-object'],
    ['an array document', '[]', 'policy', 'not-an-object'],
    [
      'an unknown top-level key',
      JSON.stringify(document({ extra: true })),
      'policy',
      'unknown-key'
    ],
    [
      'a missing policy version',
      JSON.stringify(document({ policyVersion: undefined })),
      'policyVersion',
      'missing'
    ],
    [
      'an unsupported policy version',
      JSON.stringify(document({ policyVersion: 2 })),
      'policyVersion',
      'unsupported-version'
    ],
    [
      'an unknown surface',
      JSON.stringify(document({ surface: 'sign-anything' })),
      'surface',
      'invalid-identifier'
    ],
    [
      'an unknown ratifier mode',
      JSON.stringify(document({ ratifierMode: 'multisig' })),
      'ratifierMode',
      'invalid-identifier'
    ],
    [
      'a quote surface on a Setter deployment',
      JSON.stringify(document({ surface: 'quote', ratifierMode: 'setter' })),
      'surface',
      'mode-surface-mismatch'
    ],
    [
      'a ratify surface on an Ecrecover deployment',
      JSON.stringify(document({ surface: 'ratify', ratifierMode: 'ecrecover' })),
      'surface',
      'mode-surface-mismatch'
    ],
    ['a string chain id', JSON.stringify(document({ chainId: '8453' })), 'chainId', 'wrong-type'],
    ['a zero chain id', JSON.stringify(document({ chainId: 0 })), 'chainId', 'out-of-range'],
    ['an invalid maker', JSON.stringify(document({ maker: '0x1234' })), 'maker', 'invalid-address'],
    [
      'a checksum-violating mixed-case ratifier',
      JSON.stringify(document({ ratifier: '0x19e7E376E7C213B7E7e7e46cc70A5dD086DAff2A' })),
      'ratifier',
      'invalid-address'
    ],
    [
      'a missing offer window',
      JSON.stringify(document({ offerWindow: undefined })),
      'offerWindow',
      'missing'
    ],
    [
      'an unknown offer-window key',
      JSON.stringify(
        document({
          offerWindow: { freshnessCeilingSeconds: '1', maxStartAgeSeconds: '1', extra: '1' }
        })
      ),
      'offerWindow',
      'unknown-key'
    ],
    [
      'a zero freshness ceiling',
      JSON.stringify(
        document({ offerWindow: { freshnessCeilingSeconds: '0', maxStartAgeSeconds: '900' } })
      ),
      'offerWindow.freshnessCeilingSeconds',
      'out-of-range'
    ],
    ['missing markets', JSON.stringify(document({ markets: undefined })), 'markets', 'missing'],
    ['non-array markets', JSON.stringify(document({ markets: {} })), 'markets', 'wrong-type'],
    ['an empty market allowlist', JSON.stringify(document({ markets: [] })), 'markets', 'empty'],
    [
      'an unknown market key',
      JSON.stringify(document({ markets: [market({ extra: true })] })),
      'markets[0]',
      'unknown-key'
    ],
    [
      'a non-bytes32 market id',
      JSON.stringify(document({ markets: [market({ marketId: '0x5555' })] })),
      'markets[0].marketId',
      'invalid-bytes32'
    ],
    [
      'a zero market maturity',
      JSON.stringify(document({ markets: [market({ maturity: '0' })] })),
      'markets[0].maturity',
      'out-of-range'
    ],
    [
      'inverted tick bounds',
      JSON.stringify(document({ markets: [market({ minTick: '5001', maxTick: '5000' })] })),
      'markets[0].minTick',
      'incoherent-bounds'
    ],
    [
      'a tick bound above the protocol MAX_TICK',
      JSON.stringify(document({ markets: [market({ maxTick: '6745' })] })),
      'markets[0].maxTick',
      'out-of-range'
    ],
    [
      'a continuous-fee ceiling above the protocol MAX_CONTINUOUS_FEE',
      JSON.stringify(document({ markets: [market({ maxContinuousFeeCap: '317097920' })] })),
      'markets[0].maxContinuousFeeCap',
      'out-of-range'
    ],
    [
      'a duplicate market id differing only by case',
      JSON.stringify(
        document({
          markets: [
            market(),
            market({
              marketId: `0x${String(market().marketId).slice(2).toUpperCase()}`
            })
          ]
        })
      ),
      'markets[1].marketId',
      'duplicate'
    ],
    [
      'a market id that does not re-derive from the pinned struct',
      JSON.stringify(document({ markets: [market({ marketId: bytes32('55') })] })),
      'markets[0].marketId',
      'market-id-mismatch'
    ],
    [
      'a market maturity off the 15:00:00 UTC schedule',
      JSON.stringify(document({ markets: [market({ maturity: '1800000000' })] })),
      'markets[0].maturity',
      'off-schedule'
    ],
    [
      'a market maturity above the payload-codec safe-timestamp bound',
      JSON.stringify(document({ markets: [market({ maturity: '1000000000054000' })] })),
      'markets[0].maturity',
      'out-of-range'
    ],
    [
      'a missing market tick spacing',
      JSON.stringify(document({ markets: [market({ tickSpacing: undefined })] })),
      'markets[0].tickSpacing',
      'missing'
    ],
    [
      'a tick spacing that does not divide the protocol default',
      JSON.stringify(document({ markets: [market({ tickSpacing: '3' })] })),
      'markets[0].tickSpacing',
      'out-of-range'
    ],
    [
      'a zero tick spacing',
      JSON.stringify(document({ markets: [market({ tickSpacing: '0' })] })),
      'markets[0].tickSpacing',
      'out-of-range'
    ],
    [
      'a market struct field drifting from the pinned id',
      JSON.stringify(document({ markets: [market({ rcfThreshold: '1' })] })),
      'markets[0].marketId',
      'market-id-mismatch'
    ],
    [
      'a missing market loan token',
      JSON.stringify(document({ markets: [market({ loanToken: undefined })] })),
      'markets[0].loanToken',
      'missing'
    ],
    [
      'an empty market collateral list',
      JSON.stringify(document({ markets: [market({ collateralParams: [] })] })),
      'markets[0].collateralParams',
      'empty'
    ],
    [
      'an unknown collateral key',
      JSON.stringify(
        document({
          markets: [market({ collateralParams: [{ ...fixtureCollateral, extra: true }] })]
        })
      ),
      'markets[0].collateralParams[0]',
      'unknown-key'
    ],
    [
      'collaterals out of ascending token order',
      JSON.stringify(
        document({
          markets: [
            market({
              collateralParams: [
                { ...fixtureCollateral, token: '0x0000000000000000000000000000000000007001' },
                fixtureCollateral
              ]
            })
          ]
        })
      ),
      'markets[0].collateralParams[1].token',
      'collateral-order'
    ],
    [
      'a duplicate collateral token',
      JSON.stringify(
        document({
          markets: [market({ collateralParams: [fixtureCollateral, fixtureCollateral] })]
        })
      ),
      'markets[0].collateralParams[1].token',
      'collateral-order'
    ],
    [
      'missing contract pins',
      JSON.stringify(document({ contracts: undefined })),
      'contracts',
      'missing'
    ],
    [
      'an unknown contracts key',
      JSON.stringify(
        document({
          contracts: { midnight: FIXTURE_MIDNIGHT, mempool: FIXTURE_MEMPOOL, extra: true }
        })
      ),
      'contracts',
      'unknown-key'
    ],
    [
      'a mempool pinned to the singleton address',
      JSON.stringify(
        document({ contracts: { midnight: FIXTURE_MIDNIGHT, mempool: FIXTURE_MIDNIGHT } })
      ),
      'contracts.mempool',
      'duplicate'
    ],
    [
      'a ratifier pinned to the singleton address',
      JSON.stringify(document({ ratifier: FIXTURE_MIDNIGHT })),
      'ratifier',
      'duplicate'
    ],
    [
      'a ratifier pinned to the mempool address',
      JSON.stringify(document({ ratifier: FIXTURE_MEMPOOL })),
      'ratifier',
      'duplicate'
    ],
    [
      'a missing total lend-exposure cap',
      JSON.stringify(document({ maxTotalLendExposureAssets: undefined })),
      'maxTotalLendExposureAssets',
      'missing'
    ],
    [
      'missing fee ceilings',
      JSON.stringify(document({ feeCeilings: undefined })),
      'feeCeilings',
      'missing'
    ],
    [
      'an unknown fee-ceiling class',
      JSON.stringify(
        document({
          feeCeilings: {
            routine: routineCeiling,
            protected: protectedCeiling,
            emergency: routineCeiling
          }
        })
      ),
      'feeCeilings',
      'unknown-key'
    ],
    [
      'a zero routine gas ceiling',
      JSON.stringify(
        document({
          feeCeilings: { routine: { ...routineCeiling, gas: '0' }, protected: protectedCeiling }
        })
      ),
      'feeCeilings.routine.gas',
      'out-of-range'
    ],
    [
      'a routine max fee below its priority fee',
      JSON.stringify(
        document({
          feeCeilings: {
            routine: { ...routineCeiling, maxFeePerGas: '1499999999' },
            protected: protectedCeiling
          }
        })
      ),
      'feeCeilings.routine.maxFeePerGas',
      'incoherent-bounds'
    ],
    [
      'a protected max fee one wei below the emergency bump',
      JSON.stringify(
        document({
          feeCeilings: {
            routine: routineCeiling,
            protected: {
              maxFeePerGas: '3374999999',
              maxPriorityFeePerGas: '1687500000',
              gas: protectedCeiling.gas
            }
          }
        })
      ),
      'feeCeilings.protected.maxFeePerGas',
      'insufficient-protected-ceiling'
    ],
    [
      'a protected priority fee one wei below the emergency bump',
      JSON.stringify(
        document({
          feeCeilings: {
            routine: routineCeiling,
            protected: { ...protectedCeiling, maxPriorityFeePerGas: '1687499999' }
          }
        })
      ),
      'feeCeilings.protected.maxPriorityFeePerGas',
      'insufficient-protected-ceiling'
    ],
    [
      'a protected gas ceiling below the routine gas ceiling',
      JSON.stringify(
        document({
          feeCeilings: {
            routine: routineCeiling,
            protected: { ...protectedCeiling, gas: '399999' }
          }
        })
      ),
      'feeCeilings.protected.gas',
      'insufficient-protected-ceiling'
    ],
    [
      'missing remediations',
      JSON.stringify(document({ remediations: undefined })),
      'remediations',
      'missing'
    ],
    [
      'an empty remediation manifest on the setup-remediation surface',
      JSON.stringify(document({ surface: 'setup-remediation', remediations: [] })),
      'remediations',
      'empty'
    ],
    [
      'an invalid remediation variant id',
      JSON.stringify(
        document({ remediations: [{ variant: 'Loan-Asset', feeCeiling: routineCeiling }] })
      ),
      'remediations[0].variant',
      'invalid-identifier'
    ],
    [
      'a duplicate remediation variant',
      JSON.stringify(
        document({
          remediations: [
            { variant: 'loan-asset-approval', feeCeiling: routineCeiling },
            { variant: 'loan-asset-approval', feeCeiling: routineCeiling }
          ]
        })
      ),
      'remediations[1].variant',
      'duplicate'
    ]
  ])('rejects %s', (_description, source, field, reason) => {
    expectNotConfigured(source, field, reason)
  })
})
