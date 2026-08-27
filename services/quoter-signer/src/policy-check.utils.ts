import { hexToBigInt, isAddressEqual, zeroAddress } from 'viem'

import type { IntentFees, IntentOffer, QuoterSignerIntent } from './intent.utils'
import type {
  PolicyFeeCeiling,
  PolicyMarket,
  QuoterSignerPolicy,
  SigningSurface
} from './policy.utils'

import { IntentPolicyViolationError } from './intent-policy-violation.error'

/**
 * The one intent kind each signing surface accepts. Routine and break-glass revocation share the
 * `revoke` intent but stay distinguishable by the authenticated deployment surface, never by
 * payload data (TIB-2026-08-12 caller-to-surface scoping).
 */
const SURFACE_INTENT_KINDS: Record<SigningSurface, QuoterSignerIntent['kind']> = {
  quote: 'quote',
  ratify: 'ratify',
  'routine-revoke': 'revoke',
  'break-glass-revoke': 'revoke',
  'setup-remediation': 'setup-remediation'
}

const assertFeesWithinCeiling = (
  fees: IntentFees,
  ceiling: PolicyFeeCeiling,
  field: string
): void => {
  if (BigInt(fees.maxFeePerGas) > BigInt(ceiling.maxFeePerGas)) {
    throw new IntentPolicyViolationError('fee-ceiling', `${field}.maxFeePerGas`)
  }
  if (BigInt(fees.maxPriorityFeePerGas) > BigInt(ceiling.maxPriorityFeePerGas)) {
    throw new IntentPolicyViolationError('fee-ceiling', `${field}.maxPriorityFeePerGas`)
  }
  if (BigInt(fees.gas) > BigInt(ceiling.gas)) {
    throw new IntentPolicyViolationError('fee-ceiling', `${field}.gas`)
  }
}

/** Offer time-window bounds, converted from the policy once per intent. */
type OfferWindowBounds = {
  readonly freshnessCeiling: bigint
  readonly maxStartAge: bigint
}

/** Field pins, side pins, price bounds, fee-cap ceiling, and time windows for one offer. */
const assertOfferWithinPolicy = (
  offer: IntentOffer,
  field: string,
  market: PolicyMarket,
  policy: QuoterSignerPolicy,
  window: OfferWindowBounds,
  nowSeconds: bigint
): void => {
  if (!isAddressEqual(offer.ratifier, policy.ratifier)) {
    throw new IntentPolicyViolationError('offer-pin', `${field}.ratifier`)
  }
  // The v0 policy admits no maker callback surface: callbacks stay disabled exactly as every
  // repository offer builder produces them.
  if (!isAddressEqual(offer.callback, zeroAddress)) {
    throw new IntentPolicyViolationError('offer-pin', `${field}.callback`)
  }
  if (offer.callbackData !== '0x') {
    throw new IntentPolicyViolationError('offer-pin', `${field}.callbackData`)
  }
  // Protocol rule: buys carry the zero receiver; maker sells must pay out to the maker itself.
  const receiver = offer.buy ? zeroAddress : policy.maker
  if (!isAddressEqual(offer.receiverIfMakerIsSeller, receiver)) {
    throw new IntentPolicyViolationError('offer-pin', `${field}.receiverIfMakerIsSeller`)
  }
  // The credit-reducing sell side must be reduce-only so a fill can never open new debt; the
  // exposure-increasing buy side must not be, so its lend-exposure charge stays meaningful.
  if (offer.reduceOnly !== !offer.buy) {
    throw new IntentPolicyViolationError('reduce-only-pin', `${field}.reduceOnly`)
  }
  const tick = BigInt(offer.tick)
  if (tick < BigInt(market.minTick) || tick > BigInt(market.maxTick)) {
    throw new IntentPolicyViolationError('price-bound', `${field}.tick`)
  }
  if (BigInt(offer.continuousFeeCap) > BigInt(market.maxContinuousFeeCap)) {
    throw new IntentPolicyViolationError('continuous-fee-cap', `${field}.continuousFeeCap`)
  }
  const start = BigInt(offer.start)
  const expiry = BigInt(offer.expiry)
  if (start >= expiry) throw new IntentPolicyViolationError('offer-window', `${field}.start`)
  if (expiry <= nowSeconds) {
    throw new IntentPolicyViolationError('offer-expired', `${field}.expiry`)
  }
  if (expiry > nowSeconds + window.freshnessCeiling) {
    throw new IntentPolicyViolationError('freshness-ceiling', `${field}.expiry`)
  }
  if (start + window.maxStartAge < nowSeconds) {
    throw new IntentPolicyViolationError('start-age', `${field}.start`)
  }
  if (expiry > BigInt(market.maturity)) {
    throw new IntentPolicyViolationError('expiry-after-maturity', `${field}.expiry`)
  }
}

/**
 * Midnight consumption groups are content-addressed, so one group id must bind exactly one
 * market, side, and cap value inside an intent — the static projection of the SDK's
 * `validateOfferGroup` rule and the identity the capacity-domain accounting of TIB-2026-08-12 §6
 * relies on. Canonical group re-derivation from full market parameters lands with the encoding
 * stage.
 */
type GroupBinding = {
  readonly marketKey: bigint
  readonly buy: boolean
  readonly maxAssets: string
}

const assertOffersWithinPolicy = (
  offers: readonly IntentOffer[],
  policy: QuoterSignerPolicy,
  nowSeconds: bigint
): void => {
  // Viem-first bytes32 identity: keys are the numeric value of the validated hex, so equality
  // never depends on local string casing.
  const markets = new Map(policy.markets.map(market => [hexToBigInt(market.marketId), market]))
  const window: OfferWindowBounds = {
    freshnessCeiling: BigInt(policy.offerWindow.freshnessCeilingSeconds),
    maxStartAge: BigInt(policy.offerWindow.maxStartAgeSeconds)
  }
  const groupBindings = new Map<bigint, GroupBinding>()
  // One charge per protocol consumption domain (market, group, side, cap value): per-book leaves
  // sharing a side-wide group and cap count once instead of once per rung (TIB-2026-08-12 §6).
  const lendDomains = new Map<string, { readonly marketKey: bigint; readonly assets: bigint }>()
  offers.forEach((offer, index) => {
    const field = `offers[${index}]`
    const marketKey = hexToBigInt(offer.marketId)
    const market = markets.get(marketKey)
    if (market === undefined) {
      throw new IntentPolicyViolationError('market-allowlist', `${field}.marketId`)
    }
    assertOfferWithinPolicy(offer, field, market, policy, window, nowSeconds)
    const groupKey = hexToBigInt(offer.group)
    const binding = groupBindings.get(groupKey)
    if (binding === undefined) {
      groupBindings.set(groupKey, { marketKey, buy: offer.buy, maxAssets: offer.maxAssets })
    } else if (
      binding.marketKey !== marketKey ||
      binding.buy !== offer.buy ||
      binding.maxAssets !== offer.maxAssets
    ) {
      throw new IntentPolicyViolationError('group-coherence', `${field}.group`)
    }
    if (offer.buy) {
      const domainKey = `${marketKey}:${groupKey}:${offer.maxAssets}`
      if (!lendDomains.has(domainKey)) {
        lendDomains.set(domainKey, { marketKey, assets: BigInt(offer.maxAssets) })
      }
    }
  })
  const marketLendExposure = new Map<bigint, bigint>()
  let totalLendExposure = 0n
  for (const domain of lendDomains.values()) {
    marketLendExposure.set(
      domain.marketKey,
      (marketLendExposure.get(domain.marketKey) ?? 0n) + domain.assets
    )
    totalLendExposure += domain.assets
  }
  for (const [marketKey, exposure] of marketLendExposure) {
    const market = markets.get(marketKey)
    // Every domain key comes from an allowlisted offer, so a miss here is a middleware fault —
    // deny rather than skip the cap, keeping the stage fail-closed.
    if (market === undefined) {
      throw new IntentPolicyViolationError('internal-fault', 'offers')
    }
    if (exposure > BigInt(market.maxLendExposureAssets)) {
      throw new IntentPolicyViolationError('lend-exposure-cap', 'offers')
    }
  }
  if (totalLendExposure > BigInt(policy.maxTotalLendExposureAssets)) {
    throw new IntentPolicyViolationError('total-lend-exposure-cap', 'offers')
  }
}

/**
 * Enforces the deterministic TIB-2026-08-12 deployment-policy checks on one parsed intent: the
 * surface's pinned intent kind, the chain and maker pins, per-kind fee/gas ceilings (`protected`
 * on the break-glass surface, per-variant for setup remediation, `routine` otherwise), the
 * ratifier-mode coherence of root revocations, the remediation-variant allowlist, and — for quote
 * and ratify offer sets — the market allowlist, tick price bounds, offer field pins, reduce-only
 * side pins, continuous-fee-cap ceilings, freshness/start/maturity time windows, group coherence,
 * and the static per-market and maker-wide lend-exposure caps charged once per consumption
 * domain.
 *
 * These are the checks decidable from deployment parameters and the middleware clock alone. The
 * independent-read properties (crossed books, PnL, snapshot fees, aggregate reservations, nonce
 * and balance admission) are later TIB increments; passing here therefore never implies approval.
 * @param intent - Parsed, structurally valid intent from `parseQuoterSignerIntent`.
 * @param policy - Parsed deployment policy from `parseQuoterSignerPolicy`.
 * @param nowSeconds - Middleware clock reading (unix seconds) used for every time-window check.
 * @returns Nothing; returning means no deterministic check rejected the intent.
 * @throws `IntentPolicyViolationError` naming the first violated check and field.
 */
export const assertIntentWithinPolicy = (
  intent: QuoterSignerIntent,
  policy: QuoterSignerPolicy,
  nowSeconds: bigint
): void => {
  if (SURFACE_INTENT_KINDS[policy.surface] !== intent.kind) {
    throw new IntentPolicyViolationError('surface-intent-kind', 'kind')
  }
  if (intent.chainId !== policy.chainId) {
    throw new IntentPolicyViolationError('chain-id', 'chainId')
  }
  if (!isAddressEqual(intent.maker, policy.maker)) {
    throw new IntentPolicyViolationError('maker', 'maker')
  }
  switch (intent.kind) {
    case 'quote': {
      assertOffersWithinPolicy(intent.offers, policy, nowSeconds)
      return
    }
    case 'ratify': {
      assertOffersWithinPolicy(intent.offers, policy, nowSeconds)
      assertFeesWithinCeiling(intent.fees, policy.feeCeilings.routine, 'fees')
      return
    }
    case 'revoke': {
      if (intent.operation.type === 'cancel-root' && policy.ratifierMode !== 'ecrecover') {
        throw new IntentPolicyViolationError('ratifier-mode-operation', 'operation.type')
      }
      if (intent.operation.type === 'unratify-root' && policy.ratifierMode !== 'setter') {
        throw new IntentPolicyViolationError('ratifier-mode-operation', 'operation.type')
      }
      const ceiling =
        policy.surface === 'break-glass-revoke'
          ? policy.feeCeilings.protected
          : policy.feeCeilings.routine
      assertFeesWithinCeiling(intent.fees, ceiling, 'fees')
      return
    }
    case 'setup-remediation': {
      const remediation = policy.remediations.find(entry => entry.variant === intent.remediation)
      if (remediation === undefined) {
        throw new IntentPolicyViolationError('remediation-allowlist', 'remediation')
      }
      assertFeesWithinCeiling(intent.fees, remediation.feeCeiling, 'fees')
      return
    }
  }
}
