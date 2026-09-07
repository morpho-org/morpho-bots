import type { Address, Hex } from 'viem'

import { MarketUtils } from '@morpho-org/midnight-sdk'

/**
 * Shared policy-document fixtures for the quoter-signer test suites. The parser now enforces
 * content-addressed market-id coherence through the SDK, so every suite building a policy needs
 * the same derivable market struct; this module keeps that derivation in one place while each
 * suite keeps its own intent fixtures.
 */

export const FIXTURE_MAKER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
export const FIXTURE_RATIFIER = '0x4444444444444444444444444444444444444444'
export const FIXTURE_MIDNIGHT = '0x1111111111111111111111111111111111111111'
export const FIXTURE_MEMPOOL = '0x2222222222222222222222222222222222222222'
export const FIXTURE_LOAN_TOKEN = '0x0000000000000000000000000000000000006000'
export const FIXTURE_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Default fixture maturity: a 15:00:00 UTC timestamp, matching the Mempool payload rule. */
export const FIXTURE_MATURITY = '1800025200'

const collateralToken: Address = '0x0000000000000000000000000000000000007000'
const oracle: Address = '0x0000000000000000000000000000000000008000'

/** The single collateral definition every fixture market pins, as policy-document strings. */
export const fixtureCollateral: {
  readonly token: Address
  readonly lltv: string
  readonly liquidationCursor: string
  readonly oracle: Address
} = {
  token: collateralToken,
  lltv: '770000000000000000',
  liquidationCursor: '250000000000000000',
  oracle
}

/** Derives the content-addressed market id for fixture struct values via the SDK. */
export const fixtureMarketId = (parameters: {
  readonly maturity: string
  readonly loanToken?: Address
  readonly chainId?: number
  readonly midnight?: Address
}): Hex =>
  MarketUtils.toId({
    chainId: BigInt(parameters.chainId ?? 8453),
    midnight: parameters.midnight ?? FIXTURE_MIDNIGHT,
    loanToken: parameters.loanToken ?? FIXTURE_LOAN_TOKEN,
    collateralParams: [
      {
        token: collateralToken,
        lltv: BigInt(fixtureCollateral.lltv),
        liquidationCursor: BigInt(fixtureCollateral.liquidationCursor),
        oracle
      }
    ],
    maturity: BigInt(parameters.maturity),
    rcfThreshold: 0n,
    enterGate: FIXTURE_ZERO_ADDRESS,
    liquidatorGate: FIXTURE_ZERO_ADDRESS
  })

/** Builds one coherent policy market entry whose pinned id re-derives from its struct. */
export const fixtureMarketEntry = (
  parameters: { readonly maturity?: string; readonly loanToken?: Address } = {},
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
  const maturity = parameters.maturity ?? FIXTURE_MATURITY
  const loanToken = parameters.loanToken ?? FIXTURE_LOAN_TOKEN
  return {
    marketId: fixtureMarketId({ maturity, loanToken }),
    maturity,
    tickSpacing: '4',
    loanToken,
    collateralParams: [fixtureCollateral],
    rcfThreshold: '0',
    enterGate: FIXTURE_ZERO_ADDRESS,
    liquidatorGate: FIXTURE_ZERO_ADDRESS,
    minTick: '100',
    maxTick: '5000',
    maxContinuousFeeCap: '317097919',
    maxLendExposureAssets: '20000000000',
    ...overrides
  }
}

/** Routine fee ceiling shared across suites. */
export const fixtureRoutineCeiling = {
  maxFeePerGas: '3000000000',
  maxPriorityFeePerGas: '1500000000',
  gas: '400000'
}

/** Protected fee ceiling shared across suites; covers the emergency bump of the routine class. */
export const fixtureProtectedCeiling = {
  maxFeePerGas: '30000000000',
  maxPriorityFeePerGas: '15000000000',
  gas: '800000'
}

/** Builds one complete, parseable policy document with the shared pins and one coherent market. */
export const fixturePolicyDocument = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  policyVersion: 1,
  surface: 'routine-revoke',
  ratifierMode: 'ecrecover',
  chainId: 8453,
  maker: FIXTURE_MAKER,
  ratifier: FIXTURE_RATIFIER,
  contracts: { midnight: FIXTURE_MIDNIGHT, mempool: FIXTURE_MEMPOOL },
  offerWindow: { freshnessCeilingSeconds: '3600', maxStartAgeSeconds: '900' },
  markets: [fixtureMarketEntry()],
  maxTotalLendExposureAssets: '30000000000',
  feeCeilings: { routine: fixtureRoutineCeiling, protected: fixtureProtectedCeiling },
  remediations: [{ variant: 'loan-asset-approval', feeCeiling: fixtureRoutineCeiling }],
  ...overrides
})

/** First 15:00:00 UTC maturity at least one full day past `nowSeconds`, as a decimal string. */
export const fixtureMaturityAfter = (nowSeconds: bigint): string =>
  (((nowSeconds + 2n * 86_400n) / 86_400n) * 86_400n + 54_000n).toString()
