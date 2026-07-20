import type { TransactionItem } from '../../src/midnight/client'

export const MARKET_A = `0x${'a'.repeat(64)}`
export const MARKET_B = `0x${'b'.repeat(64)}`
export const USER_ONE = '0x958eB498a4172EA513c79b09E7f064070C5b1917'
export const USER_TWO = '0x535690CB1330232dd4f2ac5B724040751bdF4C91'
export const TX_HASH = `0x${'c'.repeat(64)}`

type LendItem = Extract<TransactionItem, { event_type: 'lend' }>
type LiquidationItem = Extract<TransactionItem, { event_type: 'full_liquidation' }>
type ExitPrimaryItem = Extract<TransactionItem, { event_type: 'exit_borrow_primary' }>
type SupplyCollateralItem = Extract<TransactionItem, { event_type: 'supply_collateral' }>

export function lendItem(over: {
  id: string
  created_at: number
  market_id?: string
  assets?: string
  account?: string
}): LendItem {
  return {
    id: over.id,
    chain_id: 8453,
    market_id: over.market_id ?? MARKET_A,
    created_at: over.created_at,
    tx_hash: TX_HASH,
    event_type: 'lend',
    data: {
      account: over.account ?? USER_ONE,
      caller: USER_ONE,
      maker: USER_ONE,
      taker: USER_TWO,
      buyer: USER_ONE,
      seller: USER_TWO,
      buyer_assets: over.assets ?? '1000',
      seller_assets: over.assets ?? '1000',
      assets: over.assets ?? '1000',
      units: '1001',
      take_units: '1001',
      buyer_pending_fee_increase: '0',
      seller_pending_fee_decrease: '0',
      total_units_delta: '1001',
      payer: USER_ONE,
      receiver: USER_TWO,
      group: `0x${'d'.repeat(64)}`,
      consumed: '1000'
    }
  }
}

export function liquidationItem(over: {
  id: string
  created_at?: number
  bad_debt?: string
  pure_bad_debt_realization?: boolean
  repaid_units?: string
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
      collateral: USER_ONE,
      seized_assets: '246',
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
      collateral: USER_TWO,
      assets: over.assets ?? '1000'
    }
  }
}

/** openapi-fetch-shaped success result: { data: body, response } as fetchWithRetry consumes. */
export function apiPage<T>(body: T) {
  return { data: body, response: new Response('{}', { status: 200 }) }
}
