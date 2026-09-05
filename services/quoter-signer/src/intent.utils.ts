import type { Address, Hex } from 'viem'

import { getAddress, hexToBigInt, isAddress, isHex, size } from 'viem'

import { MalformedIntentError } from './malformed-intent.error'

/** Structured intent kinds defined by TIB-2026-08-12. */
export const INTENT_KINDS = ['quote', 'ratify', 'revoke', 'setup-remediation'] as const

/** One of the TIB-defined structured intent kinds. */
type IntentKind = (typeof INTENT_KINDS)[number]

/** A recognized intent kind, or `unknown` for anything else — the only value ever logged. */
type ClassifiedIntentKind = IntentKind | 'unknown'

/**
 * Wire-contract version implemented by this build. Version 1 is the typed intent request and
 * approval/denial response contract of TIB-2026-08-12; it bumps on any breaking envelope change.
 */
export const QUOTER_SIGNER_CONTRACT_VERSION = 1

/** Hard wire cap on total offers per quote/ratify intent: two full sides (TIB-2026-08-12 §6). */
export const MAX_INTENT_OFFERS = 80

/** Hard wire cap on same-side offers per quote/ratify intent: 40 rungs (TIB-2026-08-12 §6). */
export const MAX_INTENT_OFFERS_PER_SIDE = 40

/** Hard wire cap on distinct markets per quote/ratify intent (TIB-2026-08-12 §6). */
export const MAX_INTENT_MARKETS = 7

/**
 * Hard wire cap on groups per `consume-groups` revocation — the full two-sided wire-cap ladder's
 * group count. A larger cleanup splits into multiple revoke intents (each at its own nonce)
 * instead of one unboundedly large multicall whose caller-chosen gas limit could admit an
 * include-but-revert transaction that burns the nonce while leaving every group live.
 */
export const MAX_REVOKE_GROUPS = 80

/**
 * Canonical unsigned decimal integer string: base-10 digits with no sign, no leading zeros, and a
 * value within uint256 range (narrower where the protocol field is narrower, such as the uint128
 * offer caps). JSON cannot carry bigint, so every uint-range value on the wire — wei, assets,
 * ticks, timestamps, fees, gas — is a canonical decimal string; small protocol integers
 * (`chainId`, transaction nonces) stay JSON numbers. Every Midnight `Offer` numeric field is
 * unsigned, so the wire carries no signed values.
 */
export type UnsignedDecimal = string

/**
 * Caller-supplied EIP-1559 liveness parameters for every transaction-signing intent. They never
 * relax policy: the middleware enforces its own fee/gas ceilings and rolling signed-gas budgets on
 * top, and derives replacement fees itself.
 */
export type IntentFees = {
  /** Maximum total fee per gas in wei; must be at least `maxPriorityFeePerGas`. */
  readonly maxFeePerGas: UnsignedDecimal
  /** Maximum priority fee per gas in wei. */
  readonly maxPriorityFeePerGas: UnsignedDecimal
  /** Gas limit for the signed transaction; must be non-zero. */
  readonly gas: UnsignedDecimal
}

/**
 * One structured maker offer inside a quote or ratify intent — the JSON projection of the
 * `@morpho-org/midnight-sdk` `IOffer` shape, with two deliberate differences: bigints become
 * canonical decimal strings, and the market rides as its Midnight `marketId` only. Market
 * parameters are policy-relevant, so the middleware resolves them from its own allowlist and
 * independent reads; nothing policy-relevant comes from the request. Offers are listed in exact
 * tree order with explicit consumption groups so the middleware can re-derive the identical offer
 * tree and root before signing (sign-what-you-encode).
 */
export type IntentOffer = {
  /** Midnight market id (bytes32) the offer trades; must be middleware-allowlisted. */
  readonly marketId: Hex
  /** Whether the maker buys units (lends). */
  readonly buy: boolean
  /** Start timestamp in unix seconds. */
  readonly start: UnsignedDecimal
  /** Expiry timestamp in unix seconds; policy caps it at `min(maturity, signing freshness)`. */
  readonly expiry: UnsignedDecimal
  /** Midnight price tick (uint256; the protocol offer struct carries no signed fields). */
  readonly tick: UnsignedDecimal
  /**
   * Explicit consumption-group id (bytes32). Midnight groups are content-addressed (derived from
   * offer contents) and consumption is keyed per maker on chain; policy enforces that one group
   * binds one market, side, and cap inside an intent, and canonical group re-derivation happens at
   * encoding time.
   */
  readonly group: Hex
  /** Maker callback contract; policy pins the expected value. */
  readonly callback: Address
  /** Callback payload; policy pins the expected value. */
  readonly callbackData: Hex
  /** Receiver used when the maker is the seller; policy pins the expected value. */
  readonly receiverIfMakerIsSeller: Address
  /** Ratifier contract; policy pins the configured deployment. */
  readonly ratifier: Address
  /** Whether the offer can only reduce maker exposure. */
  readonly reduceOnly: boolean
  /** Contract v1 accepts only asset-denominated caps, so `maxUnits` is pinned to zero. */
  readonly maxUnits: '0'
  /** Maximum buyer or seller assets depending on side; non-zero and uint128-wide per the struct. */
  readonly maxAssets: UnsignedDecimal
  /** Maximum market continuous fee accepted; policy caps it at the snapshot market fee. */
  readonly continuousFeeCap: UnsignedDecimal
}

/**
 * One constrained revoke operation. The middleware canonically encodes the transaction itself:
 * group consumption is exactly `setConsumed(group, MAX_OFFER_CAP, maker)` on the Midnight
 * singleton (batches become one policy-checked multicall), root cancellation is exactly
 * `cancelRoot(maker, root)` on the Ecrecover ratifier or `setIsRootRatified(maker, root, false)`
 * on the Setter ratifier, and a self-cancel replaces the caller's own recorded pending
 * transaction at `nonce` with an empty zero-value self-send. Callers never supply targets,
 * selectors, or calldata.
 */
export type RevokeOperation =
  | {
      /** Consume one or more maker-owned offer groups to their cap. */
      readonly type: 'consume-groups'
      /** Offer-group ids (bytes32) to consume; non-empty, at most {@link MAX_REVOKE_GROUPS}. */
      readonly groups: readonly Hex[]
    }
  | {
      /** Cancel one Ecrecover-ratified root. */
      readonly type: 'cancel-root'
      /** Offer-tree root (bytes32) to cancel. */
      readonly root: Hex
    }
  | {
      /** Clear one Setter root ratification (defense in depth; group consumption is authoritative). */
      readonly type: 'unratify-root'
      /** Offer-tree root (bytes32) to un-ratify. */
      readonly root: Hex
    }
  | {
      /** Replace the caller's own recorded pending transaction with a zero-value self-cancel. */
      readonly type: 'self-cancel'
      /** Account nonce of the recorded pending transaction to cancel. */
      readonly nonce: number
    }

type IntentBase = {
  /** Wire-contract version; requests carrying any other value are rejected. */
  readonly contractVersion: typeof QUOTER_SIGNER_CONTRACT_VERSION
  /** EIP-155 chain id the caller targets; must equal the middleware's deployment pin. */
  readonly chainId: number
  /** Maker address the caller believes it is signing for; must equal the deployment pin. */
  readonly maker: Address
  /**
   * Caller-chosen idempotency key, reserved for the stored-artifact retry semantics of the
   * reservation-ledger increment. Inert until then: a replayed key re-evaluates the intent and,
   * for transaction kinds, signs again at the current pending nonce — so callers must invoke
   * synchronously and never blind-retry a timed-out signing invocation.
   */
  readonly idempotencyKey: string
}

/**
 * Ecrecover quote intent: sign the offer-tree EIP-712 digest for a structured offer set. Approval
 * returns the tree signature plus the exact encoded zero-value Mempool publication payload for the
 * non-maker broadcaster; no maker transaction is signed.
 */
export type QuoteIntent = IntentBase & {
  readonly kind: 'quote'
  /** Structured offers in exact tree order; at most 40 per side over at most 7 distinct markets. */
  readonly offers: readonly IntentOffer[]
}

/**
 * Setter ratify intent: re-validate the full offer set, re-derive its root, and sign the maker's
 * `setIsRootRatified(maker, root, true)` transaction. Approval returns that signed transaction
 * plus the independently encoded publication payload. Ratification makes the root publishable by
 * any funded sender, so this is the final publication authorization.
 */
export type RatifyIntent = IntentBase & {
  readonly kind: 'ratify'
  /** Structured offers in exact tree order; at most 40 per side over at most 7 distinct markets. */
  readonly offers: readonly IntentOffer[]
  /** Liveness fee parameters for the ratification transaction. */
  readonly fees: IntentFees
}

/**
 * Revoke intent: sign one exposure-reducing maker transaction. Near-unconditionally approved by
 * design — revocation is the always-available kill switch — and constrained to the allowlisted
 * {@link RevokeOperation} encodings under pinned chain, zero value, and fee/gas ceilings.
 */
export type RevokeIntent = IntentBase & {
  readonly kind: 'revoke'
  /** The single constrained operation to encode and sign. */
  readonly operation: RevokeOperation
  /** Liveness fee parameters for the revocation transaction. */
  readonly fees: IntentFees
}

/**
 * Setup-remediation intent: sign one manifest-pinned maintenance transaction (token approval,
 * authorization, or the native-balance sweep) named by its deployment-manifest variant id. The
 * middleware reads current allowance/authorization state itself and encodes the exact
 * transaction; callers never supply targets, spenders, amounts, or calldata. Accepted only on the
 * operator-only remediation surface during a dedicated remediation epoch.
 */
export type SetupRemediationIntent = IntentBase & {
  readonly kind: 'setup-remediation'
  /** Deployment-manifest variant id selecting the pinned remediation transaction. */
  readonly remediation: string
  /** Liveness fee parameters for the remediation transaction. */
  readonly fees: IntentFees
}

/**
 * The versioned JSON intent union accepted as the Lambda invocation payload — the complete
 * TIB-2026-08-12 v1 request contract. Anything outside this shape is rejected with a typed
 * `MalformedIntentError` denial and never interpreted best-effort.
 */
export type QuoterSignerIntent = QuoteIntent | RatifyIntent | RevokeIntent | SetupRemediationIntent

/**
 * Classifies an untrusted invocation payload into a loggable intent kind.
 *
 * Only allowlisted kinds are ever returned, so log records never carry caller-controlled strings;
 * every other shape — including non-object events — collapses to `unknown`.
 * @param event - Raw, untrusted Lambda invocation payload.
 * @returns The matched {@link IntentKind}, or `unknown` when the payload declares none.
 */
export const classifyIntentKind = (event: unknown): ClassifiedIntentKind => {
  if (typeof event !== 'object' || event === null) return 'unknown'
  const kind = (event as { readonly kind?: unknown }).kind
  return typeof kind === 'string' && (INTENT_KINDS as readonly string[]).includes(kind)
    ? (kind as IntentKind)
    : 'unknown'
}

const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9]\d{0,77})$/
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Shape of a setup-remediation deployment-manifest variant id, shared by the wire contract and
 * the policy document so callers and deployments name variants identically.
 */
export const REMEDIATION_VARIANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_UINT256 = 2n ** 256n - 1n
const MAX_UINT128 = 2n ** 128n - 1n

const plainObject = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedIntentError(field, 'not-an-object')
  }
  return value as Record<string, unknown>
}

const allowKeys = (record: Record<string, unknown>, allowed: readonly string[], field: string) => {
  const unknown = Object.keys(record).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new MalformedIntentError(field, 'unknown-key')
}

const stringValue = (value: unknown, field: string): string => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  if (typeof value !== 'string') throw new MalformedIntentError(field, 'wrong-type')
  return value
}

const booleanValue = (value: unknown, field: string): boolean => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  if (typeof value !== 'boolean') throw new MalformedIntentError(field, 'wrong-type')
  return value
}

const addressValue = (value: unknown, field: string): Address => {
  const text = stringValue(value, field)
  // Strict mode makes mixed-case input prove its EIP-55 checksum; lowercase is checksummed below.
  if (!isAddress(text)) throw new MalformedIntentError(field, 'invalid-address')
  return getAddress(text)
}

const hexValue = (value: unknown, field: string): Hex => {
  const text = stringValue(value, field)
  if (!isHex(text, { strict: true }) || text.length % 2 !== 0) {
    throw new MalformedIntentError(field, 'invalid-hex')
  }
  return text
}

const bytes32Value = (value: unknown, field: string): Hex => {
  const hex = hexValue(value, field)
  if (size(hex) !== 32) throw new MalformedIntentError(field, 'invalid-bytes32')
  return hex
}

const unsignedDecimalValue = (value: unknown, field: string): UnsignedDecimal => {
  const text = stringValue(value, field)
  if (!UNSIGNED_DECIMAL_PATTERN.test(text)) throw new MalformedIntentError(field, 'invalid-decimal')
  if (BigInt(text) > MAX_UINT256) throw new MalformedIntentError(field, 'out-of-range')
  return text
}

const uint128DecimalValue = (value: unknown, field: string): UnsignedDecimal => {
  const text = unsignedDecimalValue(value, field)
  if (BigInt(text) > MAX_UINT128) throw new MalformedIntentError(field, 'out-of-range')
  return text
}

const nonNegativeIntegerValue = (value: unknown, field: string): number => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MalformedIntentError(field, 'wrong-type')
  }
  if (value < 0) throw new MalformedIntentError(field, 'out-of-range')
  return value
}

const feesValue = (value: unknown, field: string): IntentFees => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  const record = plainObject(value, field)
  allowKeys(record, ['maxFeePerGas', 'maxPriorityFeePerGas', 'gas'], field)
  const maxFeePerGas = unsignedDecimalValue(record.maxFeePerGas, `${field}.maxFeePerGas`)
  const maxPriorityFeePerGas = unsignedDecimalValue(
    record.maxPriorityFeePerGas,
    `${field}.maxPriorityFeePerGas`
  )
  const gas = unsignedDecimalValue(record.gas, `${field}.gas`)
  if (gas === '0') throw new MalformedIntentError(`${field}.gas`, 'out-of-range')
  if (BigInt(maxFeePerGas) < BigInt(maxPriorityFeePerGas)) {
    throw new MalformedIntentError(`${field}.maxFeePerGas`, 'out-of-range')
  }
  return { maxFeePerGas, maxPriorityFeePerGas, gas }
}

const offerValue = (value: unknown, field: string): IntentOffer => {
  const record = plainObject(value, field)
  allowKeys(
    record,
    [
      'marketId',
      'buy',
      'start',
      'expiry',
      'tick',
      'group',
      'callback',
      'callbackData',
      'receiverIfMakerIsSeller',
      'ratifier',
      'reduceOnly',
      'maxUnits',
      'maxAssets',
      'continuousFeeCap'
    ],
    field
  )
  const maxUnits = unsignedDecimalValue(record.maxUnits, `${field}.maxUnits`)
  if (maxUnits !== '0') throw new MalformedIntentError(`${field}.maxUnits`, 'out-of-range')
  const maxAssets = uint128DecimalValue(record.maxAssets, `${field}.maxAssets`)
  if (maxAssets === '0') throw new MalformedIntentError(`${field}.maxAssets`, 'out-of-range')
  return {
    marketId: bytes32Value(record.marketId, `${field}.marketId`),
    buy: booleanValue(record.buy, `${field}.buy`),
    start: unsignedDecimalValue(record.start, `${field}.start`),
    expiry: unsignedDecimalValue(record.expiry, `${field}.expiry`),
    tick: unsignedDecimalValue(record.tick, `${field}.tick`),
    group: bytes32Value(record.group, `${field}.group`),
    callback: addressValue(record.callback, `${field}.callback`),
    callbackData: hexValue(record.callbackData, `${field}.callbackData`),
    receiverIfMakerIsSeller: addressValue(
      record.receiverIfMakerIsSeller,
      `${field}.receiverIfMakerIsSeller`
    ),
    ratifier: addressValue(record.ratifier, `${field}.ratifier`),
    reduceOnly: booleanValue(record.reduceOnly, `${field}.reduceOnly`),
    maxUnits: '0',
    maxAssets,
    continuousFeeCap: unsignedDecimalValue(record.continuousFeeCap, `${field}.continuousFeeCap`)
  }
}

const offersValue = (value: unknown, field: string): readonly IntentOffer[] => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  if (!Array.isArray(value)) throw new MalformedIntentError(field, 'wrong-type')
  if (value.length === 0) throw new MalformedIntentError(field, 'empty')
  if (value.length > MAX_INTENT_OFFERS) throw new MalformedIntentError(field, 'too-many-offers')
  const offers = value.map((offer, index) => offerValue(offer, `${field}[${index}]`))
  const buys = offers.filter(offer => offer.buy).length
  if (buys > MAX_INTENT_OFFERS_PER_SIDE || offers.length - buys > MAX_INTENT_OFFERS_PER_SIDE) {
    throw new MalformedIntentError(field, 'too-many-offers')
  }
  // Viem-first bytes32 identity: count distinct markets by the validated hex's numeric value.
  if (new Set(offers.map(offer => hexToBigInt(offer.marketId))).size > MAX_INTENT_MARKETS) {
    throw new MalformedIntentError(field, 'too-many-markets')
  }
  return offers
}

const revokeOperationValue = (value: unknown, field: string): RevokeOperation => {
  if (value === undefined) throw new MalformedIntentError(field, 'missing')
  const record = plainObject(value, field)
  const type = stringValue(record.type, `${field}.type`)
  if (type === 'consume-groups') {
    allowKeys(record, ['type', 'groups'], field)
    const groups = record.groups
    if (groups === undefined) throw new MalformedIntentError(`${field}.groups`, 'missing')
    if (!Array.isArray(groups)) throw new MalformedIntentError(`${field}.groups`, 'wrong-type')
    if (groups.length === 0) throw new MalformedIntentError(`${field}.groups`, 'empty')
    if (groups.length > MAX_REVOKE_GROUPS) {
      throw new MalformedIntentError(`${field}.groups`, 'too-many-groups')
    }
    return {
      type,
      groups: groups.map((group, index) => bytes32Value(group, `${field}.groups[${index}]`))
    }
  }
  if (type === 'cancel-root' || type === 'unratify-root') {
    allowKeys(record, ['type', 'root'], field)
    return { type, root: bytes32Value(record.root, `${field}.root`) }
  }
  if (type === 'self-cancel') {
    allowKeys(record, ['type', 'nonce'], field)
    return { type, nonce: nonNegativeIntegerValue(record.nonce, `${field}.nonce`) }
  }
  throw new MalformedIntentError(`${field}.type`, 'unsupported-kind')
}

const intentBaseValue = (record: Record<string, unknown>): IntentBase => {
  const chainId = record.chainId
  if (chainId === undefined) throw new MalformedIntentError('chainId', 'missing')
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) {
    throw new MalformedIntentError('chainId', 'wrong-type')
  }
  if (chainId < 1) throw new MalformedIntentError('chainId', 'out-of-range')
  const idempotencyKey = stringValue(record.idempotencyKey, 'idempotencyKey')
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new MalformedIntentError('idempotencyKey', 'invalid-identifier')
  }
  return {
    contractVersion: QUOTER_SIGNER_CONTRACT_VERSION,
    chainId,
    maker: addressValue(record.maker, 'maker'),
    idempotencyKey
  }
}

const BASE_KEYS = ['contractVersion', 'kind', 'chainId', 'maker', 'idempotencyKey'] as const

/**
 * Strictly parses an untrusted invocation payload into the versioned v1 intent union.
 *
 * Fail-closed by construction: unknown versions, kinds, and keys are rejected, every field is
 * structurally validated (checksummed addresses, bytes32 hex, canonical decimal strings, the
 * 40-per-side offer and 7-market wire caps), and the returned object is rebuilt from validated values only
 * — nothing from the caller's object graph survives. Policy validation (allowlists, bounds,
 * independent reads) is a separate later stage; this parser owns shape, not policy.
 * @param event - Raw, untrusted Lambda invocation payload.
 * @returns The validated, normalized {@link QuoterSignerIntent}.
 * @throws `MalformedIntentError` naming the first violating field and an allowlisted reason.
 */
export const parseQuoterSignerIntent = (event: unknown): QuoterSignerIntent => {
  const record = plainObject(event, 'intent')
  const version = record.contractVersion
  if (version === undefined) throw new MalformedIntentError('contractVersion', 'missing')
  if (version !== QUOTER_SIGNER_CONTRACT_VERSION) {
    throw new MalformedIntentError('contractVersion', 'unsupported-version')
  }
  const kind = record.kind
  if (kind === undefined) throw new MalformedIntentError('kind', 'missing')
  if (typeof kind !== 'string' || !(INTENT_KINDS as readonly string[]).includes(kind)) {
    throw new MalformedIntentError('kind', 'unsupported-kind')
  }
  if (kind === 'quote') {
    allowKeys(record, [...BASE_KEYS, 'offers'], 'intent')
    return { ...intentBaseValue(record), kind, offers: offersValue(record.offers, 'offers') }
  }
  if (kind === 'ratify') {
    allowKeys(record, [...BASE_KEYS, 'offers', 'fees'], 'intent')
    return {
      ...intentBaseValue(record),
      kind,
      offers: offersValue(record.offers, 'offers'),
      fees: feesValue(record.fees, 'fees')
    }
  }
  if (kind === 'revoke') {
    allowKeys(record, [...BASE_KEYS, 'operation', 'fees'], 'intent')
    return {
      ...intentBaseValue(record),
      kind,
      operation: revokeOperationValue(record.operation, 'operation'),
      fees: feesValue(record.fees, 'fees')
    }
  }
  allowKeys(record, [...BASE_KEYS, 'remediation', 'fees'], 'intent')
  const remediation = stringValue(record.remediation, 'remediation')
  if (!REMEDIATION_VARIANT_PATTERN.test(remediation)) {
    throw new MalformedIntentError('remediation', 'invalid-identifier')
  }
  return {
    ...intentBaseValue(record),
    kind: 'setup-remediation',
    remediation,
    fees: feesValue(record.fees, 'fees')
  }
}
