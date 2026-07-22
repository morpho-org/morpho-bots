import type { TransactionItem } from '../midnight/client'

type LendLeg = Extract<TransactionItem, { event_type: 'lend' }>
type BorrowLeg = Extract<TransactionItem, { event_type: 'borrow' }>

/** Both legs of one Take fill: the buyer's lend item and the seller's borrow item. */
export type TakePair = { lend: LendLeg; borrow: BorrowLeg }

/** A tick's alertable unit after leg-merging: a lone item, or a merged Take pair. */
type TakeEntry = { kind: 'item'; item: TransactionItem } | ({ kind: 'take' } & TakePair)

// One Take fill is expanded by the API into up to two items — a buyer-leg lend and a seller-leg
// borrow — that copy the event's trade-scoped fields verbatim. Matching on ALL of them (plus the
// tx envelope) pairs legs only when every shared field agrees; `consumed` is cumulative per
// (maker, group), so repeated fills of one offer inside one tx still key apart. Per-leg fields
// (`account`, `assets`, `units`) are excluded: attribution differs between legs by design.
function takeKey(item: LendLeg | BorrowLeg) {
  const { data } = item
  return [
    item.chain_id,
    item.market_id,
    item.tx_hash,
    item.created_at,
    data.maker,
    data.taker,
    data.buyer,
    data.seller,
    data.buyer_assets,
    data.seller_assets,
    data.take_units,
    data.total_units_delta,
    data.buyer_pending_fee_increase,
    data.seller_pending_fee_decrease,
    data.payer,
    data.receiver,
    data.group,
    data.consumed
  ].join('|')
}

/**
 * Folds the two legs of one Take into a single entry so the fill alerts once, not twice. Unpaired
 * trade legs pass through as singles (the counterparty's leg was an exit event, or it indexed late
 * into another tick), and every other event type is untouched. Entries keep item order, with a
 * merged pair sitting at its first leg's position.
 */
export function mergeTakeLegs(items: TransactionItem[]): TakeEntry[] {
  const waiting = new Map<string, { lends: LendLeg[]; borrows: BorrowLeg[] }>()
  const pairs = new Map<TransactionItem, TakePair>()
  const folded = new Set<TransactionItem>()
  for (const item of items) {
    if (item.event_type !== 'lend' && item.event_type !== 'borrow') continue
    const key = takeKey(item)
    const bucket = waiting.get(key) ?? { lends: [], borrows: [] }
    waiting.set(key, bucket)
    if (item.event_type === 'lend') {
      const borrow = bucket.borrows.shift()
      if (borrow) {
        pairs.set(borrow, { lend: item, borrow })
        folded.add(item)
      } else {
        bucket.lends.push(item)
      }
    } else {
      const lend = bucket.lends.shift()
      if (lend) {
        pairs.set(lend, { lend, borrow: item })
        folded.add(item)
      } else {
        bucket.borrows.push(item)
      }
    }
  }
  return items.flatMap((item): TakeEntry | TakeEntry[] => {
    if (folded.has(item)) return []
    const pair = pairs.get(item)
    return pair ? { kind: 'take', ...pair } : { kind: 'item', item }
  })
}
