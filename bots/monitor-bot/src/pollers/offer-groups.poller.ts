import type { Address } from 'viem'

import { assertNever, delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'

import type { Alert } from '../alerts/alert'
import type { components } from '../generated/midnight-api'
import type { MidnightClient } from '../midnight/client'
import type { PollerDependencies } from '../polling/poller'

import { MAX_PAGES, REQUEST_TIMEOUT_MS } from '../midnight/client'
import { Poller } from '../polling/poller'

type OfferGroup = components['schemas']['OfferGroupsResponse']['data'][number]

type GroupFingerprint = { maxAssets: string; maxUnits: string }
type MakerSnapshot = Record<string, GroupFingerprint>
type OfferGroupsCursor = Record<string, MakerSnapshot>

type OfferGroupEvent = {
  kind: 'created' | 'resized' | 'closed'
  maker: Address
  groupId: string
  /** Present for created/resized; null for closed (the group is gone from the snapshot). */
  group: OfferGroup | null
  /** Fingerprint before the change; null for created. */
  previous: GroupFingerprint | null
}

type OfferGroupsPollerOptions = { cron: string; makers: Address[] }

type OfferGroupsPollerDependencies = PollerDependencies & {
  client: MidnightClient
  minAssets: bigint
  sleep?: (ms: number) => Promise<void>
}

function fingerprint(group: OfferGroup): GroupFingerprint {
  return { maxAssets: group.max_assets, maxUnits: group.max_units }
}

// Offers roll/re-sign constantly; `consumed` moves on every take (already covered by the
// transaction pollers). Alert-worthy changes are new groups, size changes, and disappearances.
function diffSnapshots(maker: Address, prev: MakerSnapshot, groups: OfferGroup[]) {
  const events: OfferGroupEvent[] = []
  for (const group of groups) {
    const before = prev[group.id]
    if (!before) {
      events.push({ kind: 'created', maker, groupId: group.id, group, previous: null })
    } else if (before.maxAssets !== group.max_assets || before.maxUnits !== group.max_units) {
      events.push({ kind: 'resized', maker, groupId: group.id, group, previous: before })
    }
  }
  const currentIds = new Set(groups.map(group => group.id))
  for (const [groupId, before] of Object.entries(prev)) {
    if (!currentIds.has(groupId)) {
      events.push({ kind: 'closed', maker, groupId, group: null, previous: before })
    }
  }
  return events
}

function shortId(id: string) {
  return `${id.slice(0, 10)}…${id.slice(-4)}`
}

// Groups can mix buy (bid/lend) and sell (ask/borrow) offers; report the sides present.
function sideOf(group: OfferGroup | null) {
  if (!group || group.offers.length === 0) return 'unknown'
  const sides = new Set(group.offers.map(offer => (offer.buy ? 'lend' : 'borrow')))
  return [...sides].toSorted().join('+')
}

// Make orders are off-chain EIP-712 signatures — there is no tx to link until one is taken, so
// identity is group id + maker.
function formatOfferGroupAlert(event: OfferGroupEvent): Alert {
  const size = event.group?.max_assets ?? event.previous?.maxAssets ?? '0'
  const lines = [`maker: ${event.maker}`, `group: ${shortId(event.groupId)}`]
  if (event.group) {
    const markets = [...new Set(event.group.offers.map(offer => shortId(offer.market_id)))]
    lines.push(
      `side: ${sideOf(event.group)}`,
      `markets: ${markets.join(', ')}`,
      `expiry: ${event.group.expiry}`
    )
  }
  switch (event.kind) {
    case 'created':
      return {
        key: `${event.groupId}:created`,
        title: `make order posted (${sideOf(event.group)}): max ${size} assets`,
        lines,
        severity: 'info'
      }
    case 'resized':
      return {
        // Previous size in the key so A→B→A→B resizes stay distinct for dedupe consumers.
        key: `${event.groupId}:resized:${event.previous?.maxAssets}->${size}`,
        title: `make order resized (${sideOf(event.group)}): max ${size} assets (was ${event.previous?.maxAssets})`,
        lines,
        severity: 'info'
      }
    case 'closed':
      return {
        key: `${event.groupId}:closed`,
        title: `make order closed: max ${size} assets`,
        lines,
        severity: 'info'
      }
    default:
      return assertNever(event.kind)
  }
}

// Watches configured makers' active offer groups (there is no protocol-wide make-order feed —
// the endpoint is per-user and returns active groups only, so this poller diffs snapshots).
// The first tick per maker is a quiet baseline: alerting the whole standing book on every boot
// would be pure noise. Delivery nuance vs the base class's at-least-once: a failed dispatch
// re-diffs against the stale snapshot next tick, which re-derives still-visible events — but an
// ephemeral change (created then gone, or resized back) between the failure and the retry is
// lost, same spirit as the documented created-and-consumed-between-polls miss.
export class OfferGroupsPoller extends Poller<OfferGroupsCursor, OfferGroupEvent> {
  readonly id = 'make-orders'
  readonly cron: string
  private readonly makers: Address[]

  constructor(
    options: OfferGroupsPollerOptions,
    private readonly ext: OfferGroupsPollerDependencies
  ) {
    super(ext)
    this.cron = options.cron
    this.makers = options.makers
  }

  protected async fetch(cursor: OfferGroupsCursor | null) {
    const nextCursor: OfferGroupsCursor = {}
    const items: OfferGroupEvent[] = []
    let failures = 0
    for (const maker of this.makers) {
      const prev = cursor?.[maker] ?? null
      const { data: groups, error } = await tryCatch(this.fetchGroups(maker))
      if (error) {
        failures++
        this.ext.logger.warn('poll.maker_error', {
          pollerId: this.id,
          maker,
          error: ensureError(error).message
        })
        if (prev) nextCursor[maker] = prev
        continue
      }
      nextCursor[maker] = Object.fromEntries(groups.map(group => [group.id, fingerprint(group)]))
      if (prev === null) {
        this.ext.logger.info('poll.baseline', { pollerId: this.id, maker, groups: groups.length })
        continue
      }
      items.push(...diffSnapshots(maker, prev, groups))
    }
    if (this.makers.length > 0 && failures === this.makers.length) {
      throw new Error(`all ${failures} makers failed`)
    }
    return { items, nextCursor }
  }

  protected toAlerts(items: OfferGroupEvent[]) {
    return items
      .filter(event => this.sizeOf(event) >= this.ext.minAssets)
      .map(formatOfferGroupAlert)
  }

  private sizeOf(event: OfferGroupEvent) {
    return BigInt(event.group?.max_assets ?? event.previous?.maxAssets ?? '0')
  }

  private async fetchGroups(maker: Address) {
    const collected: OfferGroup[] = []
    let pageCursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchWithRetry(
        () =>
          this.ext.client.GET('/v0/midnight/users/{user-address}/offer-groups', {
            params: {
              path: { 'user-address': maker },
              query: { limit: 100, ...(pageCursor ? { cursor: pageCursor } : {}) }
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: `${this.id}.offer-groups`, sleep: this.ext.sleep ?? delay }
      )
      collected.push(...body.data)
      if (!body.cursor) return collected
      pageCursor = body.cursor
    }
    // A truncated snapshot must NOT be diffed — missing groups would fabricate `closed` alerts
    // (and re-fabricate `created` next tick). Throwing routes this maker through the failure
    // path: previous snapshot carried, retried next tick.
    this.ext.logger.warn('poll.pages_capped', { pollerId: this.id, maker, maxPages: MAX_PAGES })
    throw new Error(`offer-groups pagination capped at ${MAX_PAGES} pages for ${maker}`)
  }
}
