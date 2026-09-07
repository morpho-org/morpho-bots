import { describe, expect, it } from 'vitest'

import type {
  IntentFees,
  IntentOffer,
  QuoteIntent,
  QuoterSignerIntent,
  RatifyIntent,
  RevokeIntent,
  RevokeOperation,
  SetupRemediationIntent,
  UnsignedDecimal
} from '../src/intent.utils'
import type { MalformedIntentReason } from '../src/malformed-intent.error'

import {
  INTENT_KINDS,
  MAX_INTENT_MARKETS,
  MAX_INTENT_OFFERS,
  MAX_INTENT_OFFERS_PER_SIDE,
  MAX_REVOKE_GROUPS,
  QUOTER_SIGNER_CONTRACT_VERSION,
  classifyIntentKind,
  parseQuoterSignerIntent
} from '../src/intent.utils'
import { MalformedIntentError } from '../src/malformed-intent.error'

const wei = (value: bigint): UnsignedDecimal => value.toString()
const bytes32 = (byte: string) => `0x${byte.repeat(32)}` as const

const maker = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const zeroAddress = '0x0000000000000000000000000000000000000000'
const ratifier = '0x4444444444444444444444444444444444444444'

const fees: IntentFees = {
  maxFeePerGas: wei(2_000_000_000n),
  maxPriorityFeePerGas: wei(1_000_000_000n),
  gas: wei(90_000n)
}

const offer = (overrides: Partial<IntentOffer> = {}): IntentOffer => ({
  marketId: bytes32('55'),
  buy: true,
  start: wei(1_700_000_000n),
  expiry: wei(1_700_003_600n),
  tick: wei(120n),
  group: bytes32('66'),
  callback: zeroAddress,
  callbackData: '0x',
  receiverIfMakerIsSeller: zeroAddress,
  ratifier,
  reduceOnly: false,
  maxUnits: '0',
  maxAssets: wei(1_000_000n),
  continuousFeeCap: wei(317_097_919n),
  ...overrides
})

const base = {
  contractVersion: QUOTER_SIGNER_CONTRACT_VERSION,
  chainId: 8453,
  maker,
  idempotencyKey: 'intent-1'
} as const

const quoteIntent: QuoteIntent = { ...base, kind: 'quote', offers: [offer()] }
const ratifyIntent: RatifyIntent = { ...base, kind: 'ratify', offers: [offer()], fees }
const revokeIntent: RevokeIntent = {
  ...base,
  kind: 'revoke',
  operation: { type: 'cancel-root', root: bytes32('77') },
  fees
}
const remediationIntent: SetupRemediationIntent = {
  ...base,
  kind: 'setup-remediation',
  remediation: 'loan-asset-approval',
  fees
}

const expectMalformed = (event: unknown, field: string, reason: MalformedIntentReason) => {
  let caught: unknown
  try {
    parseQuoterSignerIntent(event)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(MalformedIntentError)
  expect(caught).toMatchObject({ field, reason, retryable: false })
}

describe('classifyIntentKind', () => {
  it.each(INTENT_KINDS)('recognizes the %s intent kind', kind => {
    expect(classifyIntentKind({ kind })).toBe(kind)
  })

  it.each([
    undefined,
    null,
    'quote',
    { kind: 'QUOTE' },
    { kind: 'drain-the-eoa' },
    { kind: 7 },
    { type: 'quote' }
  ])('collapses %j to unknown so no caller-controlled string is ever logged', event => {
    expect(classifyIntentKind(event)).toBe('unknown')
  })
})

describe('parseQuoterSignerIntent', () => {
  it.each<[string, QuoterSignerIntent]>([
    ['quote', quoteIntent],
    ['ratify', ratifyIntent],
    ['revoke', revokeIntent],
    ['setup-remediation', remediationIntent]
  ])('round-trips a valid %s intent', (_kind, intent) => {
    expect(parseQuoterSignerIntent(JSON.parse(JSON.stringify(intent)))).toStrictEqual(intent)
  })

  it.each<RevokeOperation>([
    { type: 'consume-groups', groups: [bytes32('11'), bytes32('22')] },
    { type: 'unratify-root', root: bytes32('33') },
    { type: 'self-cancel', nonce: 0 }
  ])('accepts the %j revoke operation', operation => {
    expect(parseQuoterSignerIntent({ ...revokeIntent, operation })).toStrictEqual({
      ...revokeIntent,
      operation
    })
  })

  it('rebuilds the intent from validated values and checksums addresses', () => {
    const parsed = parseQuoterSignerIntent({
      ...quoteIntent,
      maker: maker.toLowerCase(),
      offers: [{ ...offer(), receiverIfMakerIsSeller: maker.toLowerCase() }]
    })
    expect(parsed.maker).toBe(maker)
    expect(parsed.kind === 'quote' && parsed.offers[0]?.receiverIfMakerIsSeller).toBe(maker)
  })

  it('accepts exactly the offer, per-side, and market wire caps', () => {
    const offers = Array.from({ length: MAX_INTENT_OFFERS }, (_ignored, index) =>
      offer({
        marketId: bytes32((10 + (index % MAX_INTENT_MARKETS)).toString()),
        buy: index % 2 === 0
      })
    )
    const parsed = parseQuoterSignerIntent({ ...quoteIntent, offers })
    expect(parsed.kind === 'quote' && parsed.offers).toHaveLength(MAX_INTENT_OFFERS)
  })

  it('accepts the extreme in-range decimal boundaries', () => {
    const boundary = offer({
      maxAssets: (2n ** 128n - 1n).toString(),
      tick: (2n ** 256n - 1n).toString()
    })
    expect(parseQuoterSignerIntent({ ...quoteIntent, offers: [boundary] })).toBeDefined()
  })

  it('rejects one same-side offer above the per-side wire cap', () => {
    const offers = Array.from({ length: MAX_INTENT_OFFERS_PER_SIDE + 1 }, () => offer())
    expectMalformed({ ...quoteIntent, offers }, 'offers', 'too-many-offers')
  })

  it('accepts exactly the consume-groups wire cap and rejects one group above it', () => {
    const groups = (length: number) =>
      Array.from({ length }, (_ignored, index) => bytes32((10 + (index % 90)).toString()))
    const atCap = parseQuoterSignerIntent({
      ...revokeIntent,
      operation: { type: 'consume-groups', groups: groups(MAX_REVOKE_GROUPS) }
    })
    expect(
      atCap.kind === 'revoke' && atCap.operation.type === 'consume-groups' && atCap.operation.groups
    ).toHaveLength(MAX_REVOKE_GROUPS)
    expectMalformed(
      {
        ...revokeIntent,
        operation: { type: 'consume-groups', groups: groups(MAX_REVOKE_GROUPS + 1) }
      },
      'operation.groups',
      'too-many-groups'
    )
  })

  it.each<[string, unknown, string, MalformedIntentReason]>([
    ['a non-object payload', 'quote', 'intent', 'not-an-object'],
    ['an array payload', [], 'intent', 'not-an-object'],
    ['a null payload', null, 'intent', 'not-an-object'],
    [
      'a missing contract version',
      { ...quoteIntent, contractVersion: undefined },
      'contractVersion',
      'missing'
    ],
    [
      'an unsupported contract version',
      { ...quoteIntent, contractVersion: 2 },
      'contractVersion',
      'unsupported-version'
    ],
    ['a missing kind', { ...base }, 'kind', 'missing'],
    ['an unsupported kind', { ...base, kind: 'drain-the-eoa' }, 'kind', 'unsupported-kind'],
    ['an unknown top-level key', { ...revokeIntent, extra: true }, 'intent', 'unknown-key'],
    ['a quote smuggling fees', { ...quoteIntent, fees }, 'intent', 'unknown-key'],
    ['a string chain id', { ...quoteIntent, chainId: '8453' }, 'chainId', 'wrong-type'],
    ['a zero chain id', { ...quoteIntent, chainId: 0 }, 'chainId', 'out-of-range'],
    ['an invalid maker', { ...quoteIntent, maker: '0x1234' }, 'maker', 'invalid-address'],
    [
      'a checksum-violating mixed-case maker',
      { ...quoteIntent, maker: '0x19e7E376E7C213B7E7e7e46cc70A5dD086DAff2A' },
      'maker',
      'invalid-address'
    ],
    [
      'a decimal above the uint256 ceiling',
      { ...quoteIntent, offers: [offer({ start: (2n ** 256n).toString() })] },
      'offers[0].start',
      'out-of-range'
    ],
    [
      'a maxAssets above the uint128 struct width',
      { ...quoteIntent, offers: [offer({ maxAssets: (2n ** 128n).toString() })] },
      'offers[0].maxAssets',
      'out-of-range'
    ],
    [
      'a negative tick',
      { ...quoteIntent, offers: [offer({ tick: '-120' })] },
      'offers[0].tick',
      'invalid-decimal'
    ],
    [
      'a tick above the uint256 ceiling',
      { ...quoteIntent, offers: [offer({ tick: (2n ** 256n).toString() })] },
      'offers[0].tick',
      'out-of-range'
    ],
    [
      'an empty idempotency key',
      { ...quoteIntent, idempotencyKey: '' },
      'idempotencyKey',
      'invalid-identifier'
    ],
    [
      'an oversized idempotency key',
      { ...quoteIntent, idempotencyKey: 'k'.repeat(129) },
      'idempotencyKey',
      'invalid-identifier'
    ],
    ['missing offers', { ...base, kind: 'quote' }, 'offers', 'missing'],
    ['non-array offers', { ...quoteIntent, offers: {} }, 'offers', 'wrong-type'],
    ['an empty offer set', { ...quoteIntent, offers: [] }, 'offers', 'empty'],
    [
      'a non-bytes32 market id',
      { ...quoteIntent, offers: [offer({ marketId: '0x5555' })] },
      'offers[0].marketId',
      'invalid-bytes32'
    ],
    [
      'an unknown offer key',
      { ...quoteIntent, offers: [{ ...offer(), price: '1' }] },
      'offers[0]',
      'unknown-key'
    ],
    [
      'a non-zero maxUnits',
      { ...quoteIntent, offers: [offer({ maxUnits: '1' as never })] },
      'offers[0].maxUnits',
      'out-of-range'
    ],
    [
      'a zero maxAssets',
      { ...quoteIntent, offers: [offer({ maxAssets: '0' })] },
      'offers[0].maxAssets',
      'out-of-range'
    ],
    [
      'a negative-zero tick',
      { ...quoteIntent, offers: [offer({ tick: '-0' })] },
      'offers[0].tick',
      'invalid-decimal'
    ],
    [
      'a leading-zero decimal',
      { ...quoteIntent, offers: [offer({ start: '01' })] },
      'offers[0].start',
      'invalid-decimal'
    ],
    [
      'a bigint-hostile decimal',
      { ...quoteIntent, offers: [offer({ maxAssets: '1e6' })] },
      'offers[0].maxAssets',
      'invalid-decimal'
    ],
    [
      'an odd-length callback payload',
      { ...quoteIntent, offers: [offer({ callbackData: '0xabc' })] },
      'offers[0].callbackData',
      'invalid-hex'
    ],
    ['missing ratify fees', { ...base, kind: 'ratify', offers: [offer()] }, 'fees', 'missing'],
    [
      'a zero gas limit',
      { ...revokeIntent, fees: { ...fees, gas: '0' } },
      'fees.gas',
      'out-of-range'
    ],
    [
      'a max fee below the priority fee',
      { ...revokeIntent, fees: { ...fees, maxFeePerGas: '1' } },
      'fees.maxFeePerGas',
      'out-of-range'
    ],
    [
      'an unknown fee key',
      { ...revokeIntent, fees: { ...fees, gasPrice: '1' } },
      'fees',
      'unknown-key'
    ],
    ['a missing revoke operation', { ...base, kind: 'revoke', fees }, 'operation', 'missing'],
    [
      'an unsupported revoke operation',
      { ...revokeIntent, operation: { type: 'transfer', root: bytes32('77') } },
      'operation.type',
      'unsupported-kind'
    ],
    [
      'an empty consume-groups batch',
      { ...revokeIntent, operation: { type: 'consume-groups', groups: [] } },
      'operation.groups',
      'empty'
    ],
    [
      'a non-bytes32 group member',
      { ...revokeIntent, operation: { type: 'consume-groups', groups: [bytes32('11'), '0x11'] } },
      'operation.groups[1]',
      'invalid-bytes32'
    ],
    [
      'a root smuggled into a self-cancel',
      { ...revokeIntent, operation: { type: 'self-cancel', nonce: 1, root: bytes32('77') } },
      'operation',
      'unknown-key'
    ],
    [
      'a negative self-cancel nonce',
      { ...revokeIntent, operation: { type: 'self-cancel', nonce: -1 } },
      'operation.nonce',
      'out-of-range'
    ],
    [
      'a fractional self-cancel nonce',
      { ...revokeIntent, operation: { type: 'self-cancel', nonce: 1.5 } },
      'operation.nonce',
      'wrong-type'
    ],
    [
      'an uppercase remediation variant',
      { ...remediationIntent, remediation: 'Loan_Asset' },
      'remediation',
      'invalid-identifier'
    ]
  ])('rejects %s', (_name, event, field, reason) => {
    expectMalformed(event, field, reason)
  })

  it('rejects one offer above the wire cap', () => {
    const offers = Array.from({ length: MAX_INTENT_OFFERS + 1 }, () => offer())
    expectMalformed({ ...quoteIntent, offers }, 'offers', 'too-many-offers')
  })

  it('rejects one distinct market above the wire cap, counting mixed-case ids once', () => {
    const offers = Array.from({ length: MAX_INTENT_MARKETS + 1 }, (_ignored, index) =>
      offer({ marketId: bytes32((10 + index).toString()) })
    )
    expectMalformed({ ...quoteIntent, offers }, 'offers', 'too-many-markets')
    const deduplicated = [
      ...offers.slice(0, MAX_INTENT_MARKETS - 1),
      offer({ marketId: bytes32('1A') }),
      offer({ marketId: bytes32('1a') })
    ]
    expect(parseQuoterSignerIntent({ ...quoteIntent, offers: deduplicated })).toBeDefined()
  })
})
