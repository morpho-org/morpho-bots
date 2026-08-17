import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  apyToRate,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  percentToWad,
  rateToApy,
  rateToUtilization,
  utilizationToRate
} from '../src/math'

const WAD = 10n ** 18n
const RATE_AT_TARGET = parseUnits('0.03', 18) / (365n * 24n * 60n * 60n)

describe('percentToWad', () => {
  it('scales percentages to WAD fractions', () => {
    expect(percentToWad(100)).toBe(WAD)
    expect(percentToWad(4.25)).toBe(parseUnits('0.0425', 18))
    expect(percentToWad(99.99)).toBe(parseUnits('0.9999', 18))
  })
})

describe('getUtilization', () => {
  it('computes borrow/supply in WAD', () => {
    expect(
      getUtilization({
        totalSupplyAssets: 100n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 90n,
        totalBorrowShares: 0n
      })
    ).toBe((90n * WAD) / 100n)
  })

  it('returns 0 for an empty market instead of dividing by zero', () => {
    expect(
      getUtilization({
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n
      })
    ).toBe(0n)
  })
})

describe('IRM curve inversion', () => {
  it('maps rateAtTarget to the 90% target utilization and back', () => {
    expect(rateToUtilization(RATE_AT_TARGET, RATE_AT_TARGET)).toBe(parseUnits('0.9', 18))
    expect(utilizationToRate(parseUnits('0.9', 18), RATE_AT_TARGET)).toBe(RATE_AT_TARGET)
  })

  it('clamps at the curve ends', () => {
    expect(rateToUtilization(0n, RATE_AT_TARGET)).toBe(0n)
    expect(rateToUtilization(RATE_AT_TARGET * 5n, RATE_AT_TARGET)).toBe(WAD)
    // Above-WAD utilization (bad debt) yields the curve's max rate, not an extrapolation.
    expect(utilizationToRate(2n * WAD, RATE_AT_TARGET)).toBe(utilizationToRate(WAD, RATE_AT_TARGET))
  })

  it('round-trips utilization through the curve', () => {
    for (const utilization of [
      parseUnits('0.5', 18),
      parseUnits('0.9', 18),
      parseUnits('0.95', 18)
    ]) {
      const roundTripped = rateToUtilization(
        utilizationToRate(utilization, RATE_AT_TARGET),
        RATE_AT_TARGET
      )
      const delta =
        roundTripped > utilization ? roundTripped - utilization : utilization - roundTripped
      expect(delta).toBeLessThan(parseUnits('0.000001', 18))
    }
  })
})

describe('apy/rate conversions', () => {
  it('round-trips an APY through the per-second rate within tolerance', () => {
    const apy = percentToWad(5)
    const roundTripped = rateToApy(apyToRate(apy))
    const delta = roundTripped > apy ? roundTripped - apy : apy - roundTripped
    expect(delta).toBeLessThan(parseUnits('0.001', 18)) // < 0.1 percentage point
  })
})

describe('sizing helpers', () => {
  const market = {
    id: '0x01' as const,
    params: {
      loanToken: '0x0000000000000000000000000000000000000010',
      collateralToken: '0x0000000000000000000000000000000000000020',
      oracle: '0x0000000000000000000000000000000000000030',
      irm: '0x0000000000000000000000000000000000000040',
      lltv: parseUnits('0.8', 18)
    },
    state: {
      totalSupplyAssets: parseUnits('100000', 6),
      totalSupplyShares: 0n,
      totalBorrowAssets: parseUnits('45000', 6), // 45% utilization
      totalBorrowShares: 0n
    },
    cap: parseUnits('100000', 6),
    vaultAssets: parseUnits('10000', 6),
    rateAtTarget: RATE_AT_TARGET
  } as const

  it('bounds withdrawals by the vault position', () => {
    // Target 90%: could withdraw half the market's supply, but the vault only holds 10k.
    expect(getWithdrawableAmount(market, parseUnits('0.9', 18))).toBe(market.vaultAssets)
  })

  it('bounds deposits by the buffered cap headroom', () => {
    // Target 22.5% (half of current): utilization math would allow a 100k deposit, but the
    // buffered cap (99.99% of 100k) minus the current 10k position leaves ~89,990.
    const depositable = getDepositableAmount(market, parseUnits('0.225', 18), 99.99)
    expect(depositable).toBe(parseUnits('89990', 6))
  })

  it('returns zero when the cap is already reached', () => {
    const atCap = { ...market, vaultAssets: market.cap }
    expect(getDepositableAmount(atCap, parseUnits('0.225', 18), 99.99)).toBe(0n)
  })
})
