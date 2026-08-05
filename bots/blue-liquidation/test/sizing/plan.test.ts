import { describe, expect, it } from 'vitest'

import type { PlanInput } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { lifFromLltv } from '../../src/sizing/lif'
import {
  mulDivDown,
  toAssetsDown,
  toSharesUp,
  wDivUp,
  wMulDown,
  mulDivUp
} from '../../src/sizing/math'
import { plan } from '../../src/sizing/plan'

const LLTV = 86n * 10n ** 16n // 0.86e18

// An unhealthy WETH-ish position: ~1000 loan assets of debt, collateral priced ~1:1 (price = 1e36).
function baseInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    hasDebt: true,
    healthy: false,
    borrowShares: 1000n * WAD * 10n ** 6n, // ~1000 assets worth of shares (VIRTUAL_SHARES scale)
    collateral: 2000n * WAD,
    accruedTotalBorrowAssets: 5000n * WAD,
    totalBorrowShares: 5000n * WAD * 10n ** 6n,
    collateralPrice: ORACLE_PRICE_SCALE,
    lltv: LLTV,
    ...overrides
  }
}

// Blue's on-chain `seizedAssets > 0` → repaidShares derivation (Morpho.sol.liquidate), replicated
// with the round-UP chain. This is the independent oracle the underflow-safety sweep checks against;
// note it uses DIFFERENT primitives (mulDivUp / wDivUp / toSharesUp) than plan()'s double-floor.
function contractRepaidShares(input: PlanInput, seizedAssets: bigint): bigint {
  const lif = lifFromLltv(input.lltv)
  const seizedAssetsQuoted = mulDivUp(seizedAssets, input.collateralPrice, ORACLE_PRICE_SCALE)
  return toSharesUp(
    wDivUp(seizedAssetsQuoted, lif),
    input.accruedTotalBorrowAssets,
    input.totalBorrowShares
  )
}

// plan()'s own full-debt seize target (debt-binds branch value), recomputed here to assert branch wiring.
function seizeForFullDebt(input: PlanInput): bigint {
  const lif = lifFromLltv(input.lltv)
  const repaidAssetsFull = toAssetsDown(
    input.borrowShares,
    input.accruedTotalBorrowAssets,
    input.totalBorrowShares
  )
  return mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, input.collateralPrice)
}

describe('plan — skip cases', () => {
  it('skips a position with no debt', () => {
    expect(plan(baseInput({ hasDebt: false }))).toBeNull()
  })

  it('skips a healthy position', () => {
    expect(plan(baseInput({ healthy: true }))).toBeNull()
  })

  it('skips the degenerate pure-bad-debt case (collateral == 0)', () => {
    expect(plan(baseInput({ collateral: 0n }))).toBeNull()
  })

  it('skips a zero-price oracle rather than dividing by zero', () => {
    expect(plan(baseInput({ collateralPrice: 0n }))).toBeNull()
  })

  it('skips a dust position that sizes to zero seize', () => {
    // Tiny debt vs the virtual-share offset → repaidAssetsFull floors to 0 → seize 0 → null.
    expect(plan(baseInput({ borrowShares: 1n }))).toBeNull()
  })
})

describe('plan — branch selection', () => {
  it('debt binds: seizes exactly the full-debt amount when collateral is ample', () => {
    const input = baseInput({ collateral: 100_000n * WAD })
    const result = plan(input)
    expect(result).not.toBeNull()
    expect(result!.seizedAssets).toBe(seizeForFullDebt(input))
    expect(result!.seizedAssets).toBeLessThan(input.collateral)
  })

  it('collateral binds: seizes 100% of collateral when underwater', () => {
    const input = baseInput({ collateral: 100n * WAD })
    // Sanity: the full-debt seize would exceed the collateral.
    expect(seizeForFullDebt(input)).toBeGreaterThan(input.collateral)
    const result = plan(input)
    expect(result!.seizedAssets).toBe(100n * WAD)
  })
})

describe('plan — repaidShares ≤ borrowShares (no on-chain underflow)', () => {
  // The load-bearing correctness claim (TIB Open Questions / Verification): the inbound double-floor
  // in seizeForFullDebt must dominate the contract's ceil-derivation so `borrowShares -= repaidShares`
  // never underflows — on BOTH the debt-binds and collateral-binds branches.
  it('holds across a broad deterministic sweep', () => {
    const lltvs = [0n, 30n, 50n, 86n, 90n, 945n, 98n].map(p =>
      p === 945n ? 945n * 10n ** 15n : p * 10n ** 16n
    )
    // prices spanning the decimal range oracles actually return (36 + loanDec - collDec).
    const prices = [10n ** 30n, 10n ** 33n, ORACLE_PRICE_SCALE, 10n ** 39n, 10n ** 42n]
    const debts = [1n * WAD, 137n * WAD, 1000n * WAD, 999_983n * WAD]
    const shareScales = [10n ** 6n, 10n ** 6n + 7n] // shares-per-asset ~ VIRTUAL_SHARES and a skewed pool
    const collaterals = [1n, WAD / 3n, WAD, 7n * WAD, 100n * WAD, 100_000n * WAD]

    let checked = 0
    for (const lltv of lltvs)
      for (const price of prices)
        for (const debtAssets of debts)
          for (const scale of shareScales)
            for (const collateral of collaterals) {
              const tba = 5n * debtAssets + 1n
              const input: PlanInput = {
                hasDebt: true,
                healthy: false,
                borrowShares: debtAssets * scale,
                collateral,
                accruedTotalBorrowAssets: tba,
                totalBorrowShares: tba * scale,
                collateralPrice: price,
                lltv
              }
              const result = plan(input)
              if (!result) continue
              checked++
              // (1) never seizes more than the borrower's collateral.
              expect(result.seizedAssets).toBeLessThanOrEqual(collateral)
              // (2) the contract-derived repaid never exceeds the borrower's shares.
              expect(contractRepaidShares(input, result.seizedAssets)).toBeLessThanOrEqual(
                input.borrowShares
              )
            }
    // Guard against a vacuous sweep (every combo skipped would pass trivially).
    expect(checked).toBeGreaterThan(100)
  })
})
