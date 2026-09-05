import type { IMarketParams } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  Group,
  Offer,
  Payload,
  SetterRatifierUtils,
  Tree
} from '@morpho-org/midnight-sdk'
import { hexToBigInt } from 'viem'

import type { IntentOffer } from './intent.utils'
import type { PolicyMarket, QuoterSignerPolicy } from './policy.utils'
import type { EncodedPublication } from './response.utils'

import { ArtifactEncodingFailedError } from './artifact-encoding-failed.error'
import { IntentPolicyViolationError } from './intent-policy-violation.error'

/**
 * Builds the full immutable market struct for one allowlisted market from deployment pins alone.
 * The struct's `chainId` and `midnight` come from the policy document, never from the caller, so
 * everything the offer hash commits to is middleware-resolved (TIB-2026-08-12 encoding rules).
 */
const marketStruct = (market: PolicyMarket, policy: QuoterSignerPolicy): IMarketParams => ({
  chainId: BigInt(policy.chainId),
  midnight: policy.contracts.midnight,
  loanToken: market.loanToken,
  collateralParams: market.collateralParams.map(collateral => ({
    token: collateral.token,
    lltv: BigInt(collateral.lltv),
    liquidationCursor: BigInt(collateral.liquidationCursor),
    oracle: collateral.oracle
  })),
  maturity: BigInt(market.maturity),
  rcfThreshold: BigInt(market.rcfThreshold),
  enterGate: market.enterGate,
  liquidatorGate: market.liquidatorGate
})

/** Deployment pins the offer builder needs: the policy plus its market allowlist by id. */
type OfferEncodingContext = {
  readonly policy: QuoterSignerPolicy
  readonly markets: ReadonlyMap<bigint, PolicyMarket>
}

const toSdkOffer = (offer: IntentOffer, field: string, context: OfferEncodingContext): Offer => {
  const { policy, markets } = context
  const market = markets.get(hexToBigInt(offer.marketId))
  // Every offer already passed the market-allowlist check; a miss here is a middleware fault and
  // fails closed rather than encoding an unpinned market.
  if (market === undefined) throw new IntentPolicyViolationError('internal-fault', field)
  try {
    return Offer.create({
      market: marketStruct(market, policy),
      buy: offer.buy,
      // Pinned-maker injection: the encoded offer carries the policy maker by construction; the
      // intent's own maker field only ever passed the equality check against the same pin.
      maker: policy.maker,
      start: BigInt(offer.start),
      expiry: BigInt(offer.expiry),
      tick: BigInt(offer.tick),
      // The pinned per-market spacing; without it the SDK would validate against its default
      // spacing and reject protocol-valid ticks on finer-spaced books.
      tickSpacing: BigInt(market.tickSpacing),
      callback: offer.callback,
      callbackData: offer.callbackData,
      receiverIfMakerIsSeller: offer.receiverIfMakerIsSeller,
      ratifier: offer.ratifier,
      reduceOnly: offer.reduceOnly,
      maxUnits: 0n,
      maxAssets: BigInt(offer.maxAssets),
      continuousFeeCap: BigInt(offer.continuousFeeCap)
    })
  } catch (error) {
    // The SDK's own offer validation is stricter than the deterministic policy stage; its
    // rejection of caller-shaped values is a policy denial.
    throw new IntentPolicyViolationError('offer-encoding', field, { cause: error })
  }
}

type OfferRun = {
  readonly groupKey: bigint
  readonly field: string
  readonly offers: Offer[]
}

/**
 * Re-derives the canonical offer tree for one validated intent offer set — the encoding-stage
 * identity check of TIB-2026-08-12: the middleware injects the pinned maker and the policy-pinned
 * market structs into every offer, reconstructs the consumption groups from the intent's own leaf
 * order, and accepts the set only when every content-addressed group id it derives equals the
 * caller's declared id. Offers sharing a declared group must be contiguous (explicit groups
 * flatten to contiguous leaves), and a group id may appear in only one run. What this returns is
 * what gets hashed and signed — no caller-supplied group id survives into the tree unverified.
 * @param offers - Structurally valid, policy-checked intent offers in exact tree order.
 * @param policy - Parsed deployment policy supplying the maker, chain, and market pins.
 * @returns The re-derived SDK tree; its root is the only root the middleware ever signs for.
 * @throws `IntentPolicyViolationError` with check `group-derivation` when a declared group id
 * does not equal the re-derived content address (or reappears non-contiguously), `offer-encoding`
 * when the SDK rejects an offer or the assembled tree, and `internal-fault` on middleware bugs.
 */
export const buildIntentOfferTree = (
  offers: readonly IntentOffer[],
  policy: QuoterSignerPolicy
): Tree => {
  const context: OfferEncodingContext = {
    policy,
    markets: new Map(policy.markets.map(market => [hexToBigInt(market.marketId), market]))
  }
  const runs: OfferRun[] = []
  offers.forEach((offer, index) => {
    const field = `offers[${index}]`
    const groupKey = hexToBigInt(offer.group)
    const sdkOffer = toSdkOffer(offer, field, context)
    const current = runs.at(-1)
    if (current !== undefined && current.groupKey === groupKey) current.offers.push(sdkOffer)
    else runs.push({ groupKey, field: `${field}.group`, offers: [sdkOffer] })
  })
  const seen = new Set<bigint>()
  const groups = runs.map(run => {
    // A group id reappearing after a different group means the declared grouping cannot be
    // reproduced as contiguous tree leaves — the identity the capacity domains rely on breaks.
    if (seen.has(run.groupKey)) throw new IntentPolicyViolationError('group-derivation', run.field)
    seen.add(run.groupKey)
    let group: Group
    try {
      group = Group.create(run.offers)
    } catch (error) {
      throw new IntentPolicyViolationError('offer-encoding', run.field, { cause: error })
    }
    if (hexToBigInt(group.id) !== run.groupKey) {
      throw new IntentPolicyViolationError('group-derivation', run.field)
    }
    return group
  })
  try {
    return Tree.create(groups)
  } catch (error) {
    throw new IntentPolicyViolationError('offer-encoding', 'offers', { cause: error })
  }
}

/**
 * Derives the EIP-712 offer-tree digest the maker key signs for an Ecrecover quote — the exact
 * digest the Solidity ratifier recovers, with the domain pinned to the policy chain id and the
 * tree's single ratifier. This is the only quote digest ever handed to `kms:Sign`.
 * @param tree - Tree re-derived by {@link buildIntentOfferTree}.
 * @param chainId - Policy-pinned EIP-155 chain id for the EIP-712 domain.
 * @returns The 32-byte EIP-712 digest.
 * @throws `IntentPolicyViolationError` with check `offer-encoding` when the SDK rejects the tree.
 */
export const deriveEcrecoverTreeDigest = (tree: Tree, chainId: number): Hex => {
  try {
    return EcrecoverRatifierUtils.digest({ tree, chainId: BigInt(chainId) })
  } catch (error) {
    throw new IntentPolicyViolationError('offer-encoding', 'offers', { cause: error })
  }
}

// Structurally valid placeholder for the publication preflight: v must be 27/28 and r/s non-zero
// for the ratifier-data codec, while nothing verifies recovery before publication is broadcast.
const PLACEHOLDER_TREE_SIGNATURE = {
  v: 27,
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'11'.repeat(32)}`
} as const

/**
 * Dry-runs the Mempool publication encoding for an Ecrecover tree before any KMS call, using a
 * placeholder signature. `Payload.encode` enforces the Midnight API's offer-struct validity rules
 * (15:00-UTC maturities, collateral parameter bounds, time-range rules) beyond this build's
 * deterministic policy checks; running them pre-sign turns such a rejection into a plain denial
 * instead of a post-sign fault, so no `kms:Sign` call is spent on an unpublishable set.
 * @param tree - Tree re-derived by {@link buildIntentOfferTree}.
 * @returns Nothing; returning means the real publication encoding can only fail on a genuine
 * middleware fault.
 * @throws `IntentPolicyViolationError` with check `offer-encoding` when the SDK rejects the set.
 */
export const preflightEcrecoverPublication = async (tree: Tree): Promise<void> => {
  try {
    const items = tree.offers.map((offer, index) => ({
      offer,
      ratifierData: EcrecoverRatifierUtils.ratifierData({
        tree,
        leafIndex: BigInt(index),
        signature: PLACEHOLDER_TREE_SIGNATURE
      })
    }))
    await Payload.encode(items)
  } catch (error) {
    throw new IntentPolicyViolationError('offer-encoding', 'offers', { cause: error })
  }
}

/**
 * Assembles the zero-value Mempool publication payload for a signed Ecrecover quote: per-leaf
 * ratifier data embedding the maker tree signature, encoded into the Mempool wire format. Runs
 * after the KMS call by necessity — the ratifier data carries the signature — so a failure here
 * is a post-sign middleware fault; the caller has already recorded the KMS call.
 * @param parameters - The re-derived tree, the attested maker, the verified 65-byte tree
 * signature, and the policy-pinned Mempool address.
 * @returns The exact publication payload for the constrained non-maker broadcaster.
 * @throws `ArtifactEncodingFailedError` with stage `publication` on any SDK assembly fault.
 */
export const encodeEcrecoverPublication = async (parameters: {
  readonly tree: Tree
  readonly maker: Address
  readonly signature: Hex
  readonly mempool: Address
}): Promise<EncodedPublication> => {
  try {
    const items = await EcrecoverRatifierUtils.ratify({
      tree: parameters.tree,
      account: parameters.maker,
      signature: parameters.signature
    })
    return { to: parameters.mempool, data: await Payload.encode(items), value: '0' }
  } catch (error) {
    throw new ArtifactEncodingFailedError('publication', { cause: error })
  }
}

/**
 * Assembles the zero-value Mempool publication payload for a Setter ratification: per-leaf
 * ratifier data carrying only root and proof (no signature), encoded into the Mempool wire
 * format. Setter ratifier data needs no maker signature, so this runs before the KMS call — it
 * doubles as the ratify path's publication-encodability preflight, and a rejection here is the
 * same caller/policy-decidable denial the quote preflight produces, with no KMS activity.
 * @param parameters - The re-derived tree and the policy-pinned Mempool address.
 * @returns The exact publication payload for the constrained non-maker broadcaster.
 * @throws `IntentPolicyViolationError` with check `offer-encoding` when the SDK rejects the set.
 */
export const encodeSetterPublication = async (parameters: {
  readonly tree: Tree
  readonly mempool: Address
}): Promise<EncodedPublication> => {
  try {
    const items = SetterRatifierUtils.ratify({ tree: parameters.tree })
    return { to: parameters.mempool, data: await Payload.encode(items), value: '0' }
  } catch (error) {
    // Pre-sign by construction: classify like the quote preflight, so an unpublishable set is a
    // named policy denial rather than a post-sign artifact fault that never had a Sign call.
    throw new IntentPolicyViolationError('offer-encoding', 'offers', { cause: error })
  }
}
