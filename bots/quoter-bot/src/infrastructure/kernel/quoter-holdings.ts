import type { KernelState } from '@repo/kernel'
import type { Hex } from 'viem'

import { MarketUtils } from '@morpho-org/midnight-sdk'
import { parseIntentId } from '@repo/controller'

import type { LiveView } from '../../application/engine/decision'
import type { HeldBuyGroup, WorldOwnership } from '../../application/engine/world'
import type { LadderQuoteSet } from '../../domain/ladder'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { KernelGroup } from '../../kernel'
import type { LadderGroupReference } from '../ladder/ladder-group-ownership.utils'

import { kernelGroups } from './quoter-ownership'

/**
 * What one submitted replacement publishes, kept beside its act so a group's quote and offer intent
 * outlive the plan: the kernel's witness holds the offers, never the quote they were cut from.
 */
export type Publication =
  | Readonly<{
      workflow: 'ladder'
      intentId: string
      marketId: Hex
      quote: LadderQuoteSet
      groups: readonly LadderGroupReference[]
    }>
  | Readonly<{
      workflow: 'bootstrap'
      intentId: string
      groupId: Hex
      offer: BootstrapOffer & { tick?: bigint; continuousFeeCap?: bigint }
    }>

/** What the maker holds now: read by every readiness check and offer invalidation. */
export type QuoterOwnership = Readonly<{
  /** The maker's holdings now, from the kernel's state and this run's publications. */
  current: () => WorldOwnership
  /** Configured V0 groups, every group the kernel holds or retired, and every publication's. */
  ownedGroupIds: () => readonly Hex[]
  /** Groups the kernel is withdrawing or has retired, whose offers a lagging index may still list. */
  withdrawnGroupIds: () => readonly Hex[]
}>

const lower = (groupId: string) => groupId.toLowerCase() as Hex

const heldOf = (groups: readonly KernelGroup[]): HeldBuyGroup[] =>
  groups.flatMap(group => {
    const buys = group.offers.filter(offer => offer.buy)
    const first = buys[0]
    if (group.state === 'retired' || first === undefined) return []
    const marketIds = [...new Set(buys.map(offer => lower(MarketUtils.toId(offer.market))))]
    const cap =
      first.maxUnits === 0n
        ? { kind: 'assets' as const, maximum: first.maxAssets }
        : { kind: 'units' as const, maximum: first.maxUnits }
    return [{ groupId: group.groupId, marketIds, cap }]
  })

/** A cash-capped buy stays takeable for fills that round to zero assets, so only units retire. */
const retiredUnitsCapped = (group: KernelGroup) => {
  const buys = group.offers.filter(offer => offer.buy)
  return group.state === 'retired' && buys.length > 0 && buys.every(offer => offer.maxUnits !== 0n)
}

/**
 * The maker's holdings from the kernel's entries and this run's publications. A publication whose
 * plan still executes is reserved while none of its groups is retired; once the plan ends it stays
 * only while the kernel holds its groups. Every unretired buy group the kernel holds reserves cash,
 * revoking ones and ones adopted from an earlier run included, though only this run's publications
 * name a quote: an adopted group is never part of a live book.
 * @param state - The kernel's state, or `undefined` before it is read.
 * @param publications - The publications this run submitted.
 * @param v0GroupIds - Configured V0 bootstrap group ids, always counted as owned.
 * @returns The maker's ownership as world reads and preparations consume it.
 */
export const holdingsOf = (
  state: KernelState | undefined,
  publications: readonly Publication[],
  v0GroupIds: readonly Hex[]
): WorldOwnership => {
  const groups = kernelGroups(Object.values(state?.entries ?? {}))
  const held = new Set(groups.filter(group => group.state !== 'retired').map(g => g.groupId))
  const retired = new Set(groups.filter(group => group.state === 'retired').map(g => g.groupId))
  const executing = (intentId: string) => state?.plans[intentId]?.status === 'executing'
  const kept = (intentId: string, groupId: Hex) =>
    executing(intentId) ? !retired.has(lower(groupId)) : held.has(lower(groupId))
  const ladderPublications = publications.flatMap(publication => {
    if (publication.workflow !== 'ladder') return []
    const groupsKept = publication.groups.filter(group => kept(publication.intentId, group.groupId))
    if (groupsKept.length === 0) return []
    const status = executing(publication.intentId) ? 'reserved' : 'confirmed'
    const { marketId, quote } = publication
    return [{ marketId, quote, groups: groupsKept, status } as const]
  })
  const bootstrap = publications.flatMap(publication =>
    publication.workflow === 'bootstrap' && kept(publication.intentId, publication.groupId)
      ? [publication]
      : []
  )
  const kernelBootstrap = groups
    .filter(group => group.workflow === 'bootstrap')
    .map(group => group.groupId)
  return {
    ladderPublications,
    bootstrapGroupIds: [
      ...new Set([
        ...v0GroupIds.map(lower),
        ...bootstrap.map(publication => lower(publication.groupId)),
        ...kernelBootstrap
      ])
    ],
    bootstrapOffers: bootstrap.map(publication => ({
      groupId: lower(publication.groupId),
      ...publication.offer
    })),
    heldBuyGroups: heldOf(groups),
    retiredGroupIds: groups.filter(retiredUnitsCapped).map(group => group.groupId)
  }
}

/**
 * The maker's ownership over the kernel's state and this run's publications, read on every call.
 * @param state - Reads the kernel's current state.
 * @param publications - Reads this run's publications.
 * @param v0GroupIds - Configured V0 bootstrap group ids, always counted as owned.
 * @returns Live accessors; nothing is cached between calls.
 */
export const createQuoterOwnership = (
  state: () => KernelState | undefined,
  publications: () => readonly Publication[],
  v0GroupIds: readonly Hex[]
): QuoterOwnership => {
  const current = () => holdingsOf(state(), publications(), v0GroupIds)
  return {
    current,
    ownedGroupIds: () => {
      const owned = current()
      return [
        ...new Set([
          ...owned.bootstrapGroupIds,
          ...owned.ladderPublications.flatMap(p => p.groups.map(group => lower(group.groupId))),
          ...kernelGroups(Object.values(state()?.entries ?? {})).map(group => group.groupId)
        ])
      ]
    },
    withdrawnGroupIds: () =>
      kernelGroups(Object.values(state()?.entries ?? {}))
        .filter(group => group.state === 'revoking' || group.state === 'retired')
        .map(group => group.groupId)
  }
}

/**
 * A market's own live book: the exposed and live entries its intents created this run. An entry
 * adopted from an earlier run is never counted live, since that run's later stages may never have
 * published it; withdraw-at-start cancels it.
 * @param state - The kernel's state, or `undefined` before it is read.
 * @param key - The market's controller key.
 * @returns The market's exposed and live groups this run created; empty before state is read.
 */
export const liveViewOf = (state: KernelState | undefined, key: string): LiveView => ({
  live: Object.values(state?.entries ?? {}).flatMap(entry => {
    if (entry.adopted || (entry.state !== 'exposed' && entry.state !== 'live')) return []
    if (parseIntentId(entry.intentId)?.key !== key) return []
    const [group] = kernelGroups([entry])
    if (!group) return []
    return [
      { id: entry.spec.id, detail: { groupId: group.groupId, buy: group.offers[0]?.buy ?? true } }
    ]
  })
})
