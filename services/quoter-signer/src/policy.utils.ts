import type { Address, Hex } from 'viem'

import { MAX_CONTINUOUS_FEE, MAX_TICK } from '@morpho-org/midnight-sdk'
import { getAddress, isAddress, isHex, size } from 'viem'

import type { UnsignedDecimal } from './intent.utils'

import { REMEDIATION_VARIANT_PATTERN } from './intent.utils'
import { PolicyNotConfiguredError } from './policy-not-configured.error'

/**
 * Deployment parameter carrying the JSON policy document parsed by
 * {@link parseQuoterSignerPolicy}. Policy parameters live in the middleware's deployment, never in
 * the request (TIB-2026-08-12), so this environment variable is the only policy source.
 */
export const QUOTER_SIGNER_POLICY_VARIABLE = 'QUOTER_SIGNER_POLICY'

/** Policy-document version implemented by this build; any other value refuses to serve. */
export const QUOTER_SIGNER_POLICY_VERSION = 1

/**
 * The five signing surfaces of the TIB-2026-08-12 mode-aware deployment shape. Each deployed
 * function pins exactly one surface in its own configuration — never from caller data — and the
 * surface decides which intent kind is accepted and which fee-ceiling class applies (`protected`
 * for break-glass revocation, per-variant for setup remediation, `routine` otherwise).
 */
export const SIGNING_SURFACES = [
  'quote',
  'ratify',
  'routine-revoke',
  'break-glass-revoke',
  'setup-remediation'
] as const

/** One of the {@link SIGNING_SURFACES}. */
export type SigningSurface = (typeof SIGNING_SURFACES)[number]

/**
 * The configured ratifier deployment kinds. Ecrecover deployments quote via EIP-712 tree
 * signatures and cancel roots with `cancelRoot`; Setter deployments ratify via
 * `setIsRootRatified` transactions and un-ratify with the same selector.
 */
export const RATIFIER_MODES = ['ecrecover', 'setter'] as const

/** One of the {@link RATIFIER_MODES}. */
export type RatifierMode = (typeof RATIFIER_MODES)[number]

/**
 * One EIP-1559 fee/gas ceiling class. Caller-supplied intent fees must stay at or below every
 * field; the ceilings never relax the caller's own values.
 */
export type PolicyFeeCeiling = {
  /** Maximum total fee per gas in wei the middleware will sign. */
  readonly maxFeePerGas: UnsignedDecimal
  /** Maximum priority fee per gas in wei the middleware will sign. */
  readonly maxPriorityFeePerGas: UnsignedDecimal
  /** Maximum gas limit the middleware will sign; must be non-zero. */
  readonly gas: UnsignedDecimal
}

/**
 * One allowlisted Midnight market with its per-market policy parameters: the immutable maturity,
 * the tick price bounds, the continuous-fee-cap ceiling, and the lend-exposure cap charged by
 * exposure-increasing buy offers.
 */
export type PolicyMarket = {
  /** Midnight market id (bytes32) this entry allowlists. */
  readonly marketId: Hex
  /** Market maturity in unix seconds; offer expiries beyond it are denied. */
  readonly maturity: UnsignedDecimal
  /** Inclusive lower tick bound; at least 0. */
  readonly minTick: UnsignedDecimal
  /** Inclusive upper tick bound; at most the protocol `MAX_TICK`. */
  readonly maxTick: UnsignedDecimal
  /**
   * Static ceiling for caller-supplied `continuousFeeCap` values, at most the protocol
   * `MAX_CONTINUOUS_FEE`. The snapshot-derived market-fee bound of TIB-2026-08-12 lands with the
   * independent-read stage; this ceiling is the deterministic necessary condition until then.
   */
  readonly maxContinuousFeeCap: UnsignedDecimal
  /** Per-market lend-exposure cap (loan-asset units) for buy consumption domains. */
  readonly maxLendExposureAssets: UnsignedDecimal
}

/** One manifest-pinned setup-remediation variant this deployment accepts. */
export type PolicyRemediation = {
  /** Deployment-manifest variant id callers may name. */
  readonly variant: string
  /** Fee/gas ceiling class for this variant's transaction. */
  readonly feeCeiling: PolicyFeeCeiling
}

/**
 * The complete deployment policy document of the quoter-signer middleware — the "bounds and pins
 * from its own deployment parameters" of TIB-2026-08-12. Every field is required on every surface
 * so one reviewed document serves all deployments of the shared image; nothing in it comes from
 * callers.
 */
export type QuoterSignerPolicy = {
  /** Policy-document version; any other value refuses to serve. */
  readonly policyVersion: typeof QUOTER_SIGNER_POLICY_VERSION
  /** The signing surface this deployment pins. */
  readonly surface: SigningSurface
  /** The configured ratifier deployment kind. */
  readonly ratifierMode: RatifierMode
  /** EIP-155 chain id every intent must target. */
  readonly chainId: number
  /** The one maker address this middleware signs for. */
  readonly maker: Address
  /** The configured ratifier contract; every offer's `ratifier` field must equal it. */
  readonly ratifier: Address
  /** Offer time-window policy applied from the middleware's own clock. */
  readonly offerWindow: {
    /** Maximum seconds between signing time and offer expiry; must be non-zero. */
    readonly freshnessCeilingSeconds: UnsignedDecimal
    /** Maximum seconds an offer's start may lie before signing time. */
    readonly maxStartAgeSeconds: UnsignedDecimal
  }
  /** Non-empty market allowlist; offers on any other market are denied. */
  readonly markets: readonly PolicyMarket[]
  /** Maker-wide lend-exposure cap across every market in one intent. */
  readonly maxTotalLendExposureAssets: UnsignedDecimal
  /** Fee/gas ceiling classes; deployment validation pins the emergency-bump reserve between them. */
  readonly feeCeilings: {
    /** Ceilings for routine transaction intents (ratify, routine revoke). */
    readonly routine: PolicyFeeCeiling
    /** Ceilings for the operator-only break-glass revoke surface. */
    readonly protected: PolicyFeeCeiling
  }
  /** Manifest-pinned setup-remediation variants; may be empty on non-remediation deployments. */
  readonly remediations: readonly PolicyRemediation[]
}

// These structural helpers deliberately mirror `intent.utils.ts` instead of sharing one module:
// each fail-closed parser owns its error type and stays independently auditable end to end, which
// this TIB values over DRY for the middleware root of trust. Keep changes to either set in sync.
const MAX_UINT256 = 2n ** 256n - 1n
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9]\d{0,77})$/

const plainObject = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyNotConfiguredError(field, 'not-an-object')
  }
  return value as Record<string, unknown>
}

const allowKeys = (record: Record<string, unknown>, allowed: readonly string[], field: string) => {
  const unknown = Object.keys(record).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new PolicyNotConfiguredError(field, 'unknown-key')
}

const stringValue = (value: unknown, field: string): string => {
  if (value === undefined) throw new PolicyNotConfiguredError(field, 'missing')
  if (typeof value !== 'string') throw new PolicyNotConfiguredError(field, 'wrong-type')
  return value
}

const addressValue = (value: unknown, field: string): Address => {
  const text = stringValue(value, field)
  // Strict mode makes mixed-case input prove its EIP-55 checksum; lowercase is checksummed below.
  if (!isAddress(text)) throw new PolicyNotConfiguredError(field, 'invalid-address')
  return getAddress(text)
}

const bytes32Value = (value: unknown, field: string): Hex => {
  const text = stringValue(value, field)
  if (!isHex(text, { strict: true }) || text.length % 2 !== 0) {
    throw new PolicyNotConfiguredError(field, 'invalid-hex')
  }
  if (size(text) !== 32) throw new PolicyNotConfiguredError(field, 'invalid-bytes32')
  return text
}

const unsignedDecimalValue = (value: unknown, field: string): UnsignedDecimal => {
  const text = stringValue(value, field)
  if (!UNSIGNED_DECIMAL_PATTERN.test(text)) {
    throw new PolicyNotConfiguredError(field, 'invalid-decimal')
  }
  if (BigInt(text) > MAX_UINT256) throw new PolicyNotConfiguredError(field, 'out-of-range')
  return text
}

const boundedDecimalValue = (value: unknown, field: string, maximum: bigint): UnsignedDecimal => {
  const text = unsignedDecimalValue(value, field)
  if (BigInt(text) > maximum) throw new PolicyNotConfiguredError(field, 'out-of-range')
  return text
}

const nonZeroDecimalValue = (value: unknown, field: string): UnsignedDecimal => {
  const text = unsignedDecimalValue(value, field)
  if (text === '0') throw new PolicyNotConfiguredError(field, 'out-of-range')
  return text
}

const arrayValue = (value: unknown, field: string): readonly unknown[] => {
  if (value === undefined) throw new PolicyNotConfiguredError(field, 'missing')
  if (!Array.isArray(value)) throw new PolicyNotConfiguredError(field, 'wrong-type')
  return value
}

const feeCeilingValue = (value: unknown, field: string): PolicyFeeCeiling => {
  if (value === undefined) throw new PolicyNotConfiguredError(field, 'missing')
  const record = plainObject(value, field)
  allowKeys(record, ['maxFeePerGas', 'maxPriorityFeePerGas', 'gas'], field)
  const maxFeePerGas = unsignedDecimalValue(record.maxFeePerGas, `${field}.maxFeePerGas`)
  const maxPriorityFeePerGas = unsignedDecimalValue(
    record.maxPriorityFeePerGas,
    `${field}.maxPriorityFeePerGas`
  )
  const gas = nonZeroDecimalValue(record.gas, `${field}.gas`)
  if (BigInt(maxFeePerGas) < BigInt(maxPriorityFeePerGas)) {
    throw new PolicyNotConfiguredError(`${field}.maxFeePerGas`, 'incoherent-bounds')
  }
  return { maxFeePerGas, maxPriorityFeePerGas, gas }
}

const marketValue = (value: unknown, field: string): PolicyMarket => {
  const record = plainObject(value, field)
  allowKeys(
    record,
    ['marketId', 'maturity', 'minTick', 'maxTick', 'maxContinuousFeeCap', 'maxLendExposureAssets'],
    field
  )
  const minTick = boundedDecimalValue(record.minTick, `${field}.minTick`, MAX_TICK)
  const maxTick = boundedDecimalValue(record.maxTick, `${field}.maxTick`, MAX_TICK)
  if (BigInt(minTick) > BigInt(maxTick)) {
    throw new PolicyNotConfiguredError(`${field}.minTick`, 'incoherent-bounds')
  }
  return {
    marketId: bytes32Value(record.marketId, `${field}.marketId`),
    maturity: nonZeroDecimalValue(record.maturity, `${field}.maturity`),
    minTick,
    maxTick,
    maxContinuousFeeCap: boundedDecimalValue(
      record.maxContinuousFeeCap,
      `${field}.maxContinuousFeeCap`,
      MAX_CONTINUOUS_FEE
    ),
    maxLendExposureAssets: unsignedDecimalValue(
      record.maxLendExposureAssets,
      `${field}.maxLendExposureAssets`
    )
  }
}

const marketsValue = (value: unknown, field: string): readonly PolicyMarket[] => {
  const entries = arrayValue(value, field)
  if (entries.length === 0) throw new PolicyNotConfiguredError(field, 'empty')
  const markets = entries.map((entry, index) => marketValue(entry, `${field}[${index}]`))
  const seen = new Set<string>()
  markets.forEach((market, index) => {
    const key = market.marketId.toLowerCase()
    if (seen.has(key)) {
      throw new PolicyNotConfiguredError(`${field}[${index}].marketId`, 'duplicate')
    }
    seen.add(key)
  })
  return markets
}

const remediationValue = (value: unknown, field: string): PolicyRemediation => {
  const record = plainObject(value, field)
  allowKeys(record, ['variant', 'feeCeiling'], field)
  const variant = stringValue(record.variant, `${field}.variant`)
  if (!REMEDIATION_VARIANT_PATTERN.test(variant)) {
    throw new PolicyNotConfiguredError(`${field}.variant`, 'invalid-identifier')
  }
  return { variant, feeCeiling: feeCeilingValue(record.feeCeiling, `${field}.feeCeiling`) }
}

const remediationsValue = (value: unknown, field: string): readonly PolicyRemediation[] => {
  const entries = arrayValue(value, field)
  const remediations = entries.map((entry, index) => remediationValue(entry, `${field}[${index}]`))
  const seen = new Set<string>()
  remediations.forEach((remediation, index) => {
    if (seen.has(remediation.variant)) {
      throw new PolicyNotConfiguredError(`${field}[${index}].variant`, 'duplicate')
    }
    seen.add(remediation.variant)
  })
  return remediations
}

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  const text = stringValue(value, field)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new PolicyNotConfiguredError(field, 'invalid-identifier')
  }
  return text as T
}

/**
 * The exact TIB-2026-08-12 emergency replacement bump: `max(floor(x * 1125 / 1000), x + 1 wei)`.
 * Deployment validation requires the protected ceilings to cover one complete bump of the routine
 * ceilings so a routine bid can never strand the break-glass replacement path.
 * @param ceiling - Routine ceiling value in wei.
 * @returns The minimum protected ceiling that covers one full replacement of `ceiling`.
 */
export const emergencyBump = (ceiling: bigint): bigint => {
  const bumped = (ceiling * 1125n) / 1000n
  return bumped > ceiling + 1n ? bumped : ceiling + 1n
}

/**
 * Strictly parses the `QUOTER_SIGNER_POLICY` deployment parameter into the typed policy document.
 *
 * Fail-closed by construction, mirroring the intent parser: a missing document, malformed JSON,
 * unknown versions, unknown keys, and out-of-domain values are all rejected, and the returned
 * object is rebuilt from validated values only. Cross-field deployment validation runs here too:
 * tick bounds must be coherent and within the protocol `MAX_TICK`, continuous-fee ceilings within
 * `MAX_CONTINUOUS_FEE`, the quote surface requires the Ecrecover mode and ratify the Setter mode,
 * and every protected fee ceiling must cover one complete {@link emergencyBump} of its routine
 * counterpart (with `protected.gas` at least `routine.gas`).
 * @param source - Raw `QUOTER_SIGNER_POLICY` environment value, or `undefined` when unset.
 * @returns The validated, normalized {@link QuoterSignerPolicy}.
 * @throws `PolicyNotConfiguredError` naming the first violating field and an allowlisted reason —
 * the "refuse to serve" posture for a missing or invalid policy.
 */
export const parseQuoterSignerPolicy = (source: string | undefined): QuoterSignerPolicy => {
  if (source === undefined || source.trim() === '') {
    throw new PolicyNotConfiguredError(QUOTER_SIGNER_POLICY_VARIABLE, 'missing')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new PolicyNotConfiguredError(QUOTER_SIGNER_POLICY_VARIABLE, 'not-json')
  }
  const record = plainObject(parsed, 'policy')
  allowKeys(
    record,
    [
      'policyVersion',
      'surface',
      'ratifierMode',
      'chainId',
      'maker',
      'ratifier',
      'offerWindow',
      'markets',
      'maxTotalLendExposureAssets',
      'feeCeilings',
      'remediations'
    ],
    'policy'
  )
  const version = record.policyVersion
  if (version === undefined) throw new PolicyNotConfiguredError('policyVersion', 'missing')
  if (version !== QUOTER_SIGNER_POLICY_VERSION) {
    throw new PolicyNotConfiguredError('policyVersion', 'unsupported-version')
  }
  const surface = enumValue(record.surface, SIGNING_SURFACES, 'surface')
  const ratifierMode = enumValue(record.ratifierMode, RATIFIER_MODES, 'ratifierMode')
  if (surface === 'quote' && ratifierMode !== 'ecrecover') {
    throw new PolicyNotConfiguredError('surface', 'mode-surface-mismatch')
  }
  if (surface === 'ratify' && ratifierMode !== 'setter') {
    throw new PolicyNotConfiguredError('surface', 'mode-surface-mismatch')
  }
  const chainId = record.chainId
  if (chainId === undefined) throw new PolicyNotConfiguredError('chainId', 'missing')
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) {
    throw new PolicyNotConfiguredError('chainId', 'wrong-type')
  }
  if (chainId < 1) throw new PolicyNotConfiguredError('chainId', 'out-of-range')
  if (record.offerWindow === undefined) {
    throw new PolicyNotConfiguredError('offerWindow', 'missing')
  }
  const offerWindowRecord = plainObject(record.offerWindow, 'offerWindow')
  allowKeys(offerWindowRecord, ['freshnessCeilingSeconds', 'maxStartAgeSeconds'], 'offerWindow')
  const offerWindow = {
    freshnessCeilingSeconds: nonZeroDecimalValue(
      offerWindowRecord.freshnessCeilingSeconds,
      'offerWindow.freshnessCeilingSeconds'
    ),
    maxStartAgeSeconds: unsignedDecimalValue(
      offerWindowRecord.maxStartAgeSeconds,
      'offerWindow.maxStartAgeSeconds'
    )
  }
  if (record.feeCeilings === undefined) {
    throw new PolicyNotConfiguredError('feeCeilings', 'missing')
  }
  const feeCeilingsRecord = plainObject(record.feeCeilings, 'feeCeilings')
  allowKeys(feeCeilingsRecord, ['routine', 'protected'], 'feeCeilings')
  const routine = feeCeilingValue(feeCeilingsRecord.routine, 'feeCeilings.routine')
  const protectedCeiling = feeCeilingValue(feeCeilingsRecord.protected, 'feeCeilings.protected')
  if (BigInt(protectedCeiling.maxFeePerGas) < emergencyBump(BigInt(routine.maxFeePerGas))) {
    throw new PolicyNotConfiguredError(
      'feeCeilings.protected.maxFeePerGas',
      'insufficient-protected-ceiling'
    )
  }
  if (
    BigInt(protectedCeiling.maxPriorityFeePerGas) <
    emergencyBump(BigInt(routine.maxPriorityFeePerGas))
  ) {
    throw new PolicyNotConfiguredError(
      'feeCeilings.protected.maxPriorityFeePerGas',
      'insufficient-protected-ceiling'
    )
  }
  if (BigInt(protectedCeiling.gas) < BigInt(routine.gas)) {
    throw new PolicyNotConfiguredError(
      'feeCeilings.protected.gas',
      'insufficient-protected-ceiling'
    )
  }
  return {
    policyVersion: QUOTER_SIGNER_POLICY_VERSION,
    surface,
    ratifierMode,
    chainId,
    maker: addressValue(record.maker, 'maker'),
    ratifier: addressValue(record.ratifier, 'ratifier'),
    offerWindow,
    markets: marketsValue(record.markets, 'markets'),
    maxTotalLendExposureAssets: unsignedDecimalValue(
      record.maxTotalLendExposureAssets,
      'maxTotalLendExposureAssets'
    ),
    feeCeilings: { routine, protected: protectedCeiling },
    remediations: remediationsValue(record.remediations, 'remediations')
  }
}
