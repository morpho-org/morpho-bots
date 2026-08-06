import type { IMarket } from '@morpho-org/midnight-sdk'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'bun:test'
import { zeroAddress } from 'viem'

import { buyerAssetReservationCredit } from '../../src/infrastructure/reservation-credit.utils'

const market = (overrides: Partial<IMarket> = {}): IMarket => ({
  params: {
    chainId: 8453,
    midnight: '0x0000000000000000000000000000000000001000',
    loanToken: '0x0000000000000000000000000000000000006000',
    collateralParams: [
      {
        token: '0x0000000000000000000000000000000000007000',
        lltv: 770_000_000_000_000_000n,
        liquidationCursor: 250_000_000_000_000_000n,
        oracle: '0x0000000000000000000000000000000000008000'
      }
    ],
    maturity: 54_000n,
    rcfThreshold: 0n,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  },
  totalUnits: 1_000n,
  lossFactor: 0n,
  withdrawable: 500n,
  continuousFeeCredit: 0n,
  settlementFeeCbps: [0, 0, 0, 0, 0, 0, 0],
  continuousFee: 0,
  tickSpacing: 4,
  ...overrides
})

const reservation = (overrides: Record<string, unknown> = {}) => ({
  assets: 100n,
  tick: 3976n,
  market: market(),
  start: 1_000n,
  expiry: 54_000n,
  continuousFeeCap: 0n,
  settlementFee: 0n,
  timestamp: 1_000n,
  ...overrides
})

describe('buyerAssetReservationCredit', () => {
  test('uses the canonical maxAssets inverse rather than target-asset conversion', () => {
    expect(
      buyerAssetReservationCredit(
        reservation({ assets: 1n, tick: 4n }) as Parameters<typeof buyerAssetReservationCredit>[0]
      )
    ).toBe(19_999_999n)
  })

  test('reserves 105 credit units for the exact positive-rate below-one-price fixture', () => {
    expect(TickLib.tickToPrice(3976n)).toBe(953_129_400_000_000_000n)
    expect(
      buyerAssetReservationCredit(
        reservation() as Parameters<typeof buyerAssetReservationCredit>[0]
      )
    ).toBe(105n)
  })

  test('applies settlement fees and rejects an ineligible continuous-fee cap', () => {
    const feeMarket = market({
      settlementFeeCbps: [65_535, 65_535, 65_535, 65_535, 65_535, 65_535, 65_535]
    })
    expect(
      buyerAssetReservationCredit(
        reservation({ assets: 1_000_000n, market: feeMarket }) as Parameters<
          typeof buyerAssetReservationCredit
        >[0]
      )
    ).toBe(1_049_176n)
    expect(
      buyerAssetReservationCredit(
        reservation({ market: market({ continuousFee: 2 }), continuousFeeCap: 1n }) as Parameters<
          typeof buyerAssetReservationCredit
        >[0]
      )
    ).toBe(0n)
  })

  test('returns zero outside the offer window and preserves one-price and zero-price compatibility', () => {
    expect(
      buyerAssetReservationCredit(
        reservation({ timestamp: 999n }) as Parameters<typeof buyerAssetReservationCredit>[0]
      )
    ).toBe(0n)
    expect(
      buyerAssetReservationCredit(
        reservation({ tick: 0n }) as Parameters<typeof buyerAssetReservationCredit>[0]
      )
    ).toBe((1n << 256n) - 1n)
    const onePriceTick = TickLib.priceToTick(10n ** 18n, 4n)
    expect(
      buyerAssetReservationCredit(
        reservation({ tick: onePriceTick }) as Parameters<typeof buyerAssetReservationCredit>[0]
      )
    ).toBe(100n)
  })
})
