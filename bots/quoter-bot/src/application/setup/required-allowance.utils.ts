import type { Hex } from 'viem'

import { bigintMin } from '@repo/utils'

import type { LadderConfig } from '../../domain/ladder'
import type { BootstrapConfig } from '../../domain/position-bootstrap'

const bigintMax = (left: bigint, right: bigint) => (left > right ? left : right)

const cappedTotal = (cash: readonly bigint[], caps: readonly bigint[]) =>
  caps.length === 0
    ? 0n
    : bigintMin(
        cash.reduce((sum, amount) => sum + amount, 0n),
        caps.reduce(bigintMax)
      )

/** Configured ladder and bootstrap markets whose cash-side exposure bounds the approval floor. */
type RequiredAllowanceInputs = {
  /** Ladder markets; only the lend side spends allowance, so budgets and caps suffice. */
  ladder: readonly Pick<
    LadderConfig,
    | 'marketId'
    | 'higherRateBudgetAssets'
    | 'targetMarketExposureAssets'
    | 'maximumTotalExposureAssets'
  >[]
  /** Bootstrap markets; each offer spends allowance up to its market exposure cap. */
  bootstrap: readonly Pick<
    BootstrapConfig,
    'marketId' | 'offerSize' | 'creditTarget' | 'maximumMarketExposure' | 'maximumTotalExposure'
  >[]
}

/**
 * Computes the loan-asset allowance that funds one full deployment of configured buy exposure.
 * @param inputs - Ladder and bootstrap market configurations; an empty side contributes zero.
 * @returns The bigint allowance below which startup readiness warns.
 * @remarks Each ladder market contributes `min(higherRateBudgetAssets, targetMarketExposureAssets)`
 * — only the higher-rate side lends — and each bootstrap market contributes
 * `min(offerSize, creditTarget, maximumMarketExposure)`. Contributions sharing one `marketId` are
 * summed and capped by that market's loosest market-exposure bound, then the total is capped by
 * the loosest total-exposure bound, because both workflows reserve against the same portfolio.
 * Sizes are face credit (`maxUnits`), which bounds the cash a buy at a nonnegative rate spends.
 * Every buy fill draws an allowance down, rebuys after sells included; writers then size buys to
 * what remains, so this is a startup hint, not a floor.
 */
export const calculateRequiredAllowance = (inputs: RequiredAllowanceInputs): bigint => {
  const contributions = new Map<Hex, { cash: bigint[]; marketCaps: bigint[]; totalCap: bigint }>()
  const add = (marketId: Hex, cash: bigint, marketCap: bigint, totalCap: bigint) => {
    const entry = contributions.get(marketId) ?? { cash: [], marketCaps: [], totalCap }
    entry.cash.push(cash)
    entry.marketCaps.push(marketCap)
    entry.totalCap = bigintMax(entry.totalCap, totalCap)
    contributions.set(marketId, entry)
  }
  for (const market of inputs.ladder) {
    add(
      market.marketId,
      bigintMin(market.higherRateBudgetAssets, market.targetMarketExposureAssets),
      market.targetMarketExposureAssets,
      market.maximumTotalExposureAssets
    )
  }
  for (const market of inputs.bootstrap) {
    add(
      market.marketId,
      bigintMin(bigintMin(market.offerSize, market.creditTarget), market.maximumMarketExposure),
      market.maximumMarketExposure,
      market.maximumTotalExposure
    )
  }
  const markets = [...contributions.values()]
  return cappedTotal(
    markets.map(market => cappedTotal(market.cash, market.marketCaps)),
    markets.map(market => market.totalCap)
  )
}
