import { LIQUIDATION_CURSOR, MAX_LIQUIDATION_INCENTIVE_FACTOR, WAD } from '../constants';
import { min, wDivDown, wMulDown } from './math';

/**
 * Liquidation incentive factor from a market's LLTV — a pure function of LLTV (no maturity ramp, no
 * per-collateral override; Blue markets have one LLTV). Mirrors `liquidate`'s derivation verbatim:
 *
 *   LIF = min(MAX_LIQUIDATION_INCENTIVE_FACTOR, WAD.wDivDown(WAD - LIQUIDATION_CURSOR.wMulDown(WAD - lltv)))
 *
 * i.e. `1 / (1 - cursor·(1 - lltv))`, capped at 1.15e18. LIF is a market constant, so callers may
 * precompute it per market.
 */
export function lifFromLltv(lltv: bigint): bigint {
  return min(
    MAX_LIQUIDATION_INCENTIVE_FACTOR,
    wDivDown(WAD, WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv))
  );
}
