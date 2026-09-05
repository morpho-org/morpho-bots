import { describe, expect, it } from 'vitest'

import type { IntentPolicyCheck } from '../src/intent-policy-violation.error'
import type {
  IntentFees,
  IntentOffer,
  QuoterSignerIntent,
  RevokeOperation
} from '../src/intent.utils'
import type { QuoterSignerPolicy } from '../src/policy.utils'

import { IntentPolicyViolationError } from '../src/intent-policy-violation.error'
import { assertIntentWithinPolicy } from '../src/policy-check.utils'
import { parseQuoterSignerPolicy } from '../src/policy.utils'
import {
  FIXTURE_MAKER as maker,
  FIXTURE_RATIFIER as ratifier,
  fixtureMarketEntry,
  fixtureMarketId,
  fixtureMaturityAfter,
  fixturePolicyDocument
} from './policy-fixture'

const bytes32 = (byte: string) => `0x${byte.repeat(32)}` as const

const zeroAddress = '0x0000000000000000000000000000000000000000'

/**
 * Fixed middleware clock every time-window vector is phrased against — chosen so that `now +
 * 1800` is a 15:00:00 UTC timestamp, the only maturity schedule the policy parser accepts, which
 * lets the expiry-after-maturity vector pin a maturity inside the freshness window.
 */
const now = 1_700_058_600n

const defaultMaturity = fixtureMaturityAfter(now)
const loanTokenB = '0x0000000000000000000000000000000000006001'
const marketA = fixtureMarketId({ maturity: defaultMaturity })
const marketB = fixtureMarketId({ maturity: defaultMaturity, loanToken: loanTokenB })

const marketEntry = (marketId: `0x${string}`, overrides: Record<string, unknown> = {}) => {
  const maturity = typeof overrides.maturity === 'string' ? overrides.maturity : defaultMaturity
  return fixtureMarketEntry(
    {
      maturity,
      loanToken: marketId === marketB ? loanTokenB : undefined
    },
    overrides
  )
}

const policyFor = (overrides: Record<string, unknown> = {}): QuoterSignerPolicy =>
  parseQuoterSignerPolicy(
    JSON.stringify(
      fixturePolicyDocument({
        surface: 'quote',
        ratifierMode: 'ecrecover',
        markets: [marketEntry(marketA), marketEntry(marketB)],
        ...overrides
      })
    )
  )

const fees: IntentFees = {
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  gas: '90000'
}

const buyOffer = (overrides: Partial<IntentOffer> = {}): IntentOffer => ({
  marketId: marketA,
  buy: true,
  start: now.toString(),
  expiry: (now + 1800n).toString(),
  tick: '120',
  group: bytes32('66'),
  callback: zeroAddress,
  callbackData: '0x',
  receiverIfMakerIsSeller: zeroAddress,
  ratifier,
  reduceOnly: false,
  maxUnits: '0',
  maxAssets: '1000000',
  continuousFeeCap: '317097919',
  ...overrides
})

const sellOffer = (overrides: Partial<IntentOffer> = {}): IntentOffer =>
  buyOffer({
    buy: false,
    reduceOnly: true,
    receiverIfMakerIsSeller: maker,
    group: bytes32('67'),
    ...overrides
  })

const base = { contractVersion: 1, chainId: 8453, maker, idempotencyKey: 'intent-1' } as const

const quoteIntent = (offers: readonly IntentOffer[]): QuoterSignerIntent => ({
  ...base,
  kind: 'quote',
  offers
})

const ratifyIntent = (offers: readonly IntentOffer[], intentFees = fees): QuoterSignerIntent => ({
  ...base,
  kind: 'ratify',
  offers,
  fees: intentFees
})

const revokeIntent = (operation: RevokeOperation, intentFees = fees): QuoterSignerIntent => ({
  ...base,
  kind: 'revoke',
  operation,
  fees: intentFees
})

const remediationIntent = (remediation: string, intentFees = fees): QuoterSignerIntent => ({
  ...base,
  kind: 'setup-remediation',
  remediation,
  fees: intentFees
})

const expectViolation = (
  intent: QuoterSignerIntent,
  policy: QuoterSignerPolicy,
  check: IntentPolicyCheck,
  field: string
) => {
  let caught: unknown
  try {
    assertIntentWithinPolicy(intent, policy, now)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(IntentPolicyViolationError)
  expect(caught).toMatchObject({ check, field, retryable: false })
}

describe('assertIntentWithinPolicy', () => {
  it.each<[string, QuoterSignerIntent, QuoterSignerPolicy]>([
    ['quote on the quote surface', quoteIntent([buyOffer(), sellOffer()]), policyFor()],
    [
      'ratify on the ratify surface',
      ratifyIntent([buyOffer(), sellOffer()]),
      policyFor({ surface: 'ratify', ratifierMode: 'setter' })
    ],
    [
      'group consumption on the routine-revoke surface',
      revokeIntent({ type: 'consume-groups', groups: [bytes32('11')] }),
      policyFor({ surface: 'routine-revoke' })
    ],
    [
      'root cancellation on an Ecrecover routine-revoke surface',
      revokeIntent({ type: 'cancel-root', root: bytes32('77') }),
      policyFor({ surface: 'routine-revoke' })
    ],
    [
      'root un-ratification on a Setter break-glass surface',
      revokeIntent({ type: 'unratify-root', root: bytes32('77') }),
      policyFor({ surface: 'break-glass-revoke', ratifierMode: 'setter' })
    ],
    [
      'a self-cancel on the break-glass surface',
      revokeIntent({ type: 'self-cancel', nonce: 7 }),
      policyFor({ surface: 'break-glass-revoke' })
    ],
    [
      'an allowlisted remediation variant',
      remediationIntent('loan-asset-approval'),
      policyFor({ surface: 'setup-remediation' })
    ]
  ])('accepts %s', (_description, intent, policy) => {
    expect(() => assertIntentWithinPolicy(intent, policy, now)).not.toThrow()
  })

  it('accepts boundary values exactly at the policy bounds', () => {
    const boundary = quoteIntent([
      buyOffer({ tick: '100', start: (now - 900n).toString(), expiry: (now + 3600n).toString() }),
      sellOffer({ tick: '5000', expiry: (now + 1n).toString() })
    ])
    expect(() => assertIntentWithinPolicy(boundary, policyFor(), now)).not.toThrow()
  })

  it.each<[string, QuoterSignerIntent, QuoterSignerPolicy, IntentPolicyCheck, string]>([
    [
      'a quote intent on the routine-revoke surface',
      quoteIntent([buyOffer()]),
      policyFor({ surface: 'routine-revoke' }),
      'surface-intent-kind',
      'kind'
    ],
    [
      'a revoke intent on the quote surface',
      revokeIntent({ type: 'self-cancel', nonce: 1 }),
      policyFor(),
      'surface-intent-kind',
      'kind'
    ],
    [
      'a remediation intent on the break-glass surface',
      remediationIntent('loan-asset-approval'),
      policyFor({ surface: 'break-glass-revoke' }),
      'surface-intent-kind',
      'kind'
    ],
    [
      'a foreign chain id',
      { ...quoteIntent([buyOffer()]), chainId: 1 },
      policyFor(),
      'chain-id',
      'chainId'
    ],
    [
      'a foreign maker',
      { ...quoteIntent([buyOffer()]), maker: ratifier },
      policyFor(),
      'maker',
      'maker'
    ],
    [
      'an offer on a non-allowlisted market',
      quoteIntent([buyOffer({ marketId: bytes32('99') })]),
      policyFor(),
      'market-allowlist',
      'offers[0].marketId'
    ],
    [
      'a foreign ratifier',
      quoteIntent([buyOffer({ ratifier: maker })]),
      policyFor(),
      'offer-pin',
      'offers[0].ratifier'
    ],
    [
      'a non-zero callback',
      quoteIntent([buyOffer({ callback: maker })]),
      policyFor(),
      'offer-pin',
      'offers[0].callback'
    ],
    [
      'non-empty callback data',
      quoteIntent([buyOffer({ callbackData: '0xdead' })]),
      policyFor(),
      'offer-pin',
      'offers[0].callbackData'
    ],
    [
      'a buy offer with a non-zero receiver',
      quoteIntent([buyOffer({ receiverIfMakerIsSeller: maker })]),
      policyFor(),
      'offer-pin',
      'offers[0].receiverIfMakerIsSeller'
    ],
    [
      'a sell offer paying out to a foreign receiver',
      quoteIntent([sellOffer({ receiverIfMakerIsSeller: ratifier })]),
      policyFor(),
      'offer-pin',
      'offers[0].receiverIfMakerIsSeller'
    ],
    [
      'a reduce-only buy offer',
      quoteIntent([buyOffer({ reduceOnly: true })]),
      policyFor(),
      'reduce-only-pin',
      'offers[0].reduceOnly'
    ],
    [
      'a sell offer without reduce-only',
      quoteIntent([sellOffer({ reduceOnly: false })]),
      policyFor(),
      'reduce-only-pin',
      'offers[0].reduceOnly'
    ],
    [
      'a tick below the market lower bound',
      quoteIntent([buyOffer({ tick: '99' })]),
      policyFor(),
      'price-bound',
      'offers[0].tick'
    ],
    [
      'a tick above the market upper bound',
      quoteIntent([buyOffer({ tick: '5001' })]),
      policyFor(),
      'price-bound',
      'offers[0].tick'
    ],
    [
      'a continuous fee cap above the market ceiling',
      quoteIntent([buyOffer({ continuousFeeCap: '317097919' })]),
      policyFor({
        markets: [marketEntry(marketA, { maxContinuousFeeCap: '317097918' }), marketEntry(marketB)]
      }),
      'continuous-fee-cap',
      'offers[0].continuousFeeCap'
    ],
    [
      'an offer starting at or after its expiry',
      quoteIntent([buyOffer({ start: (now + 1800n).toString() })]),
      policyFor(),
      'offer-window',
      'offers[0].start'
    ],
    [
      'an already-expired offer',
      quoteIntent([buyOffer({ start: (now - 600n).toString(), expiry: now.toString() })]),
      policyFor(),
      'offer-expired',
      'offers[0].expiry'
    ],
    [
      'an expiry one second past the freshness ceiling',
      quoteIntent([buyOffer({ expiry: (now + 3601n).toString() })]),
      policyFor(),
      'freshness-ceiling',
      'offers[0].expiry'
    ],
    [
      'a start one second older than the start-age tolerance',
      quoteIntent([buyOffer({ start: (now - 901n).toString() })]),
      policyFor(),
      'start-age',
      'offers[0].start'
    ],
    [
      'an expiry one second past the market maturity',
      quoteIntent([
        buyOffer({
          marketId: fixtureMarketId({ maturity: (now + 1800n).toString() }),
          expiry: (now + 1801n).toString()
        })
      ]),
      policyFor({
        markets: [
          marketEntry(marketA, { maturity: (now + 1800n).toString() }),
          marketEntry(marketB)
        ]
      }),
      'expiry-after-maturity',
      'offers[0].expiry'
    ],
    [
      'a tick inside the price bounds but off the pinned tick spacing',
      quoteIntent([buyOffer({ tick: '121' })]),
      policyFor(),
      'tick-alignment',
      'offers[0].tick'
    ],
    [
      'one group spanning two markets',
      quoteIntent([buyOffer(), buyOffer({ marketId: marketB, group: bytes32('66') })]),
      policyFor(),
      'group-coherence',
      'offers[1].group'
    ],
    [
      'one group spanning both sides',
      quoteIntent([buyOffer(), sellOffer({ group: bytes32('66') })]),
      policyFor(),
      'group-coherence',
      'offers[1].group'
    ],
    [
      'one group carrying two cap values',
      quoteIntent([buyOffer(), buyOffer({ tick: '124', maxAssets: '2000000' })]),
      policyFor(),
      'group-coherence',
      'offers[1].group'
    ],
    [
      'ratify fees above the routine max-fee ceiling',
      ratifyIntent([buyOffer()], { ...fees, maxFeePerGas: '3000000001' }),
      policyFor({ surface: 'ratify', ratifierMode: 'setter' }),
      'fee-ceiling',
      'fees.maxFeePerGas'
    ],
    [
      'revoke fees above the routine priority ceiling',
      revokeIntent(
        { type: 'consume-groups', groups: [bytes32('11')] },
        { ...fees, maxPriorityFeePerGas: '1500000001' }
      ),
      policyFor({ surface: 'routine-revoke' }),
      'fee-ceiling',
      'fees.maxPriorityFeePerGas'
    ],
    [
      'revoke gas above the routine gas ceiling',
      revokeIntent({ type: 'self-cancel', nonce: 1 }, { ...fees, gas: '400001' }),
      policyFor({ surface: 'routine-revoke' }),
      'fee-ceiling',
      'fees.gas'
    ],
    [
      'break-glass fees above even the protected ceiling',
      revokeIntent(
        { type: 'self-cancel', nonce: 1 },
        { maxFeePerGas: '30000000001', maxPriorityFeePerGas: '1', gas: '90000' }
      ),
      policyFor({ surface: 'break-glass-revoke' }),
      'fee-ceiling',
      'fees.maxFeePerGas'
    ],
    [
      'an Ecrecover root cancellation on a Setter deployment',
      revokeIntent({ type: 'cancel-root', root: bytes32('77') }),
      policyFor({ surface: 'routine-revoke', ratifierMode: 'setter' }),
      'ratifier-mode-operation',
      'operation.type'
    ],
    [
      'a Setter root un-ratification on an Ecrecover deployment',
      revokeIntent({ type: 'unratify-root', root: bytes32('77') }),
      policyFor({ surface: 'routine-revoke' }),
      'ratifier-mode-operation',
      'operation.type'
    ],
    [
      'a remediation variant outside the manifest',
      remediationIntent('collateral-approval'),
      policyFor({ surface: 'setup-remediation' }),
      'remediation-allowlist',
      'remediation'
    ],
    [
      'remediation fees above the variant ceiling',
      remediationIntent('loan-asset-approval', { ...fees, maxFeePerGas: '3000000001' }),
      policyFor({ surface: 'setup-remediation' }),
      'fee-ceiling',
      'fees.maxFeePerGas'
    ]
  ])('denies %s', (_description, intent, policy, check, field) => {
    expectViolation(intent, policy, check, field)
  })

  it('permits fees between the routine and protected ceilings only on the break-glass surface', () => {
    const emergencyFees = {
      maxFeePerGas: '10000000000',
      maxPriorityFeePerGas: '5000000000',
      gas: '500000'
    }
    const operation: RevokeOperation = { type: 'self-cancel', nonce: 3 }
    expectViolation(
      revokeIntent(operation, emergencyFees),
      policyFor({ surface: 'routine-revoke' }),
      'fee-ceiling',
      'fees.maxFeePerGas'
    )
    expect(() =>
      assertIntentWithinPolicy(
        revokeIntent(operation, emergencyFees),
        policyFor({ surface: 'break-glass-revoke' }),
        now
      )
    ).not.toThrow()
  })

  describe('lend-exposure caps', () => {
    it('accepts distinct buy domains summing exactly to the per-market cap', () => {
      const intent = quoteIntent([
        buyOffer({ maxAssets: '15000000000' }),
        buyOffer({ tick: '124', group: bytes32('68'), maxAssets: '5000000000' })
      ])
      expect(() => assertIntentWithinPolicy(intent, policyFor(), now)).not.toThrow()
    })

    it('denies distinct buy domains overflowing the per-market cap by one', () => {
      const intent = quoteIntent([
        buyOffer({ maxAssets: '15000000000' }),
        buyOffer({ tick: '124', group: bytes32('68'), maxAssets: '5000000001' })
      ])
      expectViolation(intent, policyFor(), 'lend-exposure-cap', 'offers')
    })

    it('charges a shared per-book buy group once, not per rung', () => {
      // Two rungs share one content-addressed group and cap: naive summing would breach the
      // 20000000000 per-market cap, but the consumption domain charges 15000000000 once.
      const intent = quoteIntent([
        buyOffer({ maxAssets: '15000000000' }),
        buyOffer({ tick: '124', maxAssets: '15000000000' })
      ])
      expect(() => assertIntentWithinPolicy(intent, policyFor(), now)).not.toThrow()
    })

    it('treats group ids differing only by hex case as one consumption domain', () => {
      // Naive summing would breach the 20000000000 per-market cap; the viem-normalized group
      // identity makes both rungs one domain charged once.
      const intent = quoteIntent([
        buyOffer({ group: bytes32('aa'), maxAssets: '15000000000' }),
        buyOffer({ tick: '124', group: bytes32('AA'), maxAssets: '15000000000' })
      ])
      expect(() => assertIntentWithinPolicy(intent, policyFor(), now)).not.toThrow()
    })

    it('denies a maker-wide overflow even when every per-market cap holds', () => {
      const intent = quoteIntent([
        buyOffer({ maxAssets: '20000000000' }),
        buyOffer({ marketId: marketB, group: bytes32('69'), maxAssets: '10000000001' })
      ])
      expectViolation(intent, policyFor(), 'total-lend-exposure-cap', 'offers')
    })

    it('never charges reduce-only sell offers against lend-exposure caps', () => {
      const intent = quoteIntent([
        sellOffer({ maxAssets: '340282366920938463463374607431768211455' }),
        buyOffer({ maxAssets: '20000000000' })
      ])
      expect(() => assertIntentWithinPolicy(intent, policyFor(), now)).not.toThrow()
    })
  })
})
