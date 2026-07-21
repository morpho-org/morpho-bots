import type { Address } from 'viem'

import type { TransactionItem } from '../../src/midnight/client'
import type { OfferBucket, OfferEvent } from '../../src/pollers/book-offers.model'
import type { PriceLookup } from '../../src/tokens/prices'

export const MARKET_A = `0x${'a'.repeat(64)}`
export const MARKET_B = `0x${'b'.repeat(64)}`
export const USER_ONE = '0x958eB498a4172EA513c79b09E7f064070C5b1917'
export const USER_TWO = '0x535690CB1330232dd4f2ac5B724040751bdF4C91'
export const TX_HASH = `0x${'c'.repeat(64)}`
/** Base mainnet USDC and WETH — seeded in the registry's KNOWN_TOKENS table. */
export const USDC_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const WETH_TOKEN = '0x4200000000000000000000000000000000000006'
/** 30/09/2026 00:00 UTC — the maturity used by market fixtures across the suite. */
export const MATURITY = Date.UTC(2026, 8, 30) / 1000

/** Price cache stand-in with nothing cached — alerts render without $-figures. */
export const NO_PRICES: PriceLookup = { usd: () => null }

/** Price cache stand-in keyed `<chainId>:<lowercased address>`, mirroring the real cache. */
export function priceLookup(prices: Record<string, number>): PriceLookup {
  return { usd: (chainId, address) => prices[`${chainId}:${address.toLowerCase()}`] ?? null }
}

type LendItem = Extract<TransactionItem, { event_type: 'lend' }>
type BorrowItem = Extract<TransactionItem, { event_type: 'borrow' }>
type LiquidationItem = Extract<TransactionItem, { event_type: 'full_liquidation' }>
type ExitPrimaryItem = Extract<TransactionItem, { event_type: 'exit_borrow_primary' }>
type SupplyCollateralItem = Extract<TransactionItem, { event_type: 'supply_collateral' }>

type TradeOverrides = {
  id: string
  created_at: number
  market_id?: string
  assets?: string
  units?: string
  account?: string
}

/** Trade-scoped payload both legs of one Take share verbatim (what `takeKey` matches on). */
function tradeData(over: TradeOverrides) {
  return {
    caller: USER_ONE,
    maker: USER_ONE,
    taker: USER_TWO,
    buyer: USER_ONE,
    seller: USER_TWO,
    buyer_assets: over.assets ?? '1000',
    seller_assets: over.assets ?? '1000',
    assets: over.assets ?? '1000',
    units: over.units ?? '1001',
    take_units: over.units ?? '1001',
    buyer_pending_fee_increase: '0',
    seller_pending_fee_decrease: '0',
    total_units_delta: over.units ?? '1001',
    payer: USER_ONE,
    receiver: USER_TWO,
    group: `0x${'d'.repeat(64)}`,
    consumed: '1000'
  }
}

export function lendItem(over: TradeOverrides): LendItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: over.market_id ?? MARKET_A,
    created_at: over.created_at,
    tx_hash: TX_HASH,
    event_type: 'lend',
    data: { account: over.account ?? USER_ONE, ...tradeData(over) }
  }
}

/** The seller leg of the Take that `lendItem` builds — same overrides pair the two by default. */
export function borrowItem(over: TradeOverrides): BorrowItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: over.market_id ?? MARKET_A,
    created_at: over.created_at,
    tx_hash: TX_HASH,
    event_type: 'borrow',
    data: { account: over.account ?? USER_TWO, ...tradeData(over) }
  }
}

export function liquidationItem(over: {
  id: string
  created_at?: number
  bad_debt?: string
  pure_bad_debt_realization?: boolean
  repaid_units?: string
  seized_assets?: string
  collateral?: string
  account?: string
}): LiquidationItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: MARKET_A,
    created_at: over.created_at ?? 100,
    tx_hash: TX_HASH,
    event_type: 'full_liquidation',
    data: {
      account: over.account ?? USER_TWO,
      caller: USER_ONE,
      borrower: over.account ?? USER_TWO,
      collateral: over.collateral ?? USER_ONE,
      seized_assets: over.seized_assets ?? '246',
      repaid_units: over.repaid_units ?? '500',
      post_maturity_mode: false,
      bad_debt: over.bad_debt ?? '0',
      latest_loss_factor: '0',
      latest_continuous_fee_credit: '0',
      payer: USER_ONE,
      receiver: USER_ONE,
      pure_bad_debt_realization: over.pure_bad_debt_realization ?? false
    }
  }
}

export function exitPrimaryItem(over: {
  id: string
  units?: string
  account?: string
}): ExitPrimaryItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: MARKET_A,
    created_at: 100,
    tx_hash: TX_HASH,
    event_type: 'exit_borrow_primary',
    data: {
      account: over.account ?? USER_ONE,
      caller: USER_ONE,
      on_behalf: over.account ?? USER_ONE,
      units: over.units ?? '1000',
      payer: USER_ONE
    }
  }
}

export function supplyCollateralItem(over: { id: string; assets?: string }): SupplyCollateralItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: MARKET_A,
    created_at: 100,
    tx_hash: TX_HASH,
    event_type: 'supply_collateral',
    data: {
      account: USER_ONE,
      caller: USER_ONE,
      on_behalf: USER_ONE,
      collateral: WETH_TOKEN,
      assets: over.assets ?? '1000'
    }
  }
}

type WithdrawCollateralItem = Extract<TransactionItem, { event_type: 'withdraw_collateral' }>
type ExitBorrowSecondaryItem = Extract<TransactionItem, { event_type: 'exit_borrow_secondary' }>

export function withdrawCollateralItem(over: {
  id: string
  assets?: string
  collateral?: string
}): WithdrawCollateralItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: MARKET_A,
    created_at: 100,
    tx_hash: TX_HASH,
    event_type: 'withdraw_collateral',
    data: {
      account: USER_ONE,
      caller: USER_ONE,
      on_behalf: USER_ONE,
      receiver: USER_ONE,
      collateral: over.collateral ?? WETH_TOKEN,
      assets: over.assets ?? '1000'
    }
  }
}

/** A secondary borrow exit (a repay that crosses the book) — same trade shape as a borrow leg. */
export function exitBorrowSecondaryItem(over: TradeOverrides): ExitBorrowSecondaryItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: over.market_id ?? MARKET_A,
    created_at: over.created_at,
    tx_hash: TX_HASH,
    event_type: 'exit_borrow_secondary',
    data: { account: over.account ?? USER_ONE, ...tradeData(over) }
  }
}

/** The offer group both order fixtures share by default. */
export const OFFER_GROUP = `0x${'d'.repeat(64)}`
/** 28/08/2026 — the offer expiry rendered in an order alert's `Expiry` line. */
const OFFER_EXPIRY = Date.UTC(2026, 7, 28) / 1000

/** One book bucket; defaults to a lend-side (`bids`) offer at tick 4250 on MARKET_A. */
export function offerBucket(over: Partial<OfferBucket> = {}): OfferBucket {
  return {
    side: 'bids',
    maker: USER_ONE as Address,
    group: OFFER_GROUP,
    tick: 4250,
    maxUnits: '1000',
    maxAssets: '0',
    count: 1,
    expiry: OFFER_EXPIRY,
    ...over
  }
}

/** A book diff event; defaults to a freshly created, unpriced lend bucket on MARKET_A. */
export function offerEvent(over: Partial<OfferEvent> = {}): OfferEvent {
  return {
    kind: 'created',
    marketId: MARKET_A,
    bucket: offerBucket(),
    previous: null,
    assets: null,
    previousAssets: null,
    price: null,
    ...over
  }
}

/** openapi-fetch-shaped success result: { data: body, response } as fetchWithRetry consumes. */
export function apiPage<T>(body: T) {
  return { data: body, response: new Response('{}', { status: 200 }) }
}
