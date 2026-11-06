import { MathLib } from '@morpho-org/morpho-ts'
import { bigintMin, zeroFloorSub } from '@repo/utils'

/**
 * Lets a ladder market's sells borrow once credit runs out, against loan-asset collateral the
 * operator supplied.
 * @remarks The market must list its own loan asset as a collateral priced at exactly
 * `ORACLE_PRICE_SCALE`, which setup qualification checks; the bot never moves collateral.
 */
export type LadderDebtConfig = {
  /** Most face debt the maker may carry in the market, in loan-token base units. */
  maximumDebtUnits: bigint
  /** Seconds before maturity at which sells stop borrowing; `0` borrows until maturity. */
  stopBorrowingBeforeMaturitySeconds: number
}

/** The maker's loan-asset collateral in one market and the LLTV it borrows at. */
export type LoanCollateral = { assets: bigint; lltv: bigint }

/**
 * The most face debt the maker may carry in one market.
 * @param config - The market's debt cap.
 * @param collateral - Loan-asset collateral; absent when the market lists none.
 * @returns The lesser of the cap and the debt that collateral supports.
 * @remarks Matches Midnight's `isHealthy` for this collateral at its constant `1e36` price
 * (`collateral × lltv / WAD`, rounded down), and ignores every other collateral, so a sell sized
 * within it can never be the take that fails the seller-health check.
 */
export const debtCeilingUnits = (
  config: Pick<LadderDebtConfig, 'maximumDebtUnits'>,
  collateral?: LoanCollateral
) =>
  bigintMin(
    config.maximumDebtUnits,
    collateral === undefined
      ? 0n
      : MathLib.mulDiv(collateral.assets, collateral.lltv, MathLib.WAD, 'Down')
  )

/**
 * Face units the maker's sells may still borrow in one market.
 * @param config - The market's debt cap.
 * @param position - Face debt and loan-asset collateral read at one block.
 * @returns {@link debtCeilingUnits} minus `debt`, floored at zero.
 * @remarks Debt never accrues and the oracle is constant, so headroom only moves with fills,
 * repayments, or the operator changing collateral.
 */
export const debtHeadroomUnits = (
  config: Pick<LadderDebtConfig, 'maximumDebtUnits'>,
  position: { debt: bigint; loanCollateral?: LoanCollateral }
) => zeroFloorSub(debtCeilingUnits(config, position.loanCollateral), position.debt)
