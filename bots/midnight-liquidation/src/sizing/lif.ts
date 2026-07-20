import { TIME_TO_MAX_LIF, WAD } from '../constants';
import { min } from './math';

/**
 * Liquidation incentive factor at chain time `now`. Normal mode returns the slot's full `maxLif`;
 * post-maturity mode ramps linearly WAD → maxLif over {@link TIME_TO_MAX_LIF} seconds after
 * maturity, clamped to `maxLif`. Mirrors midnight-contracts.txt:2363-2366.
 *
 * Precondition (post-maturity mode): `now > maturity`. On-chain the `:2341` guard makes
 * `now - maturity` a positive uint before any LIF code runs; `plan()` enforces the same ordering
 * before passing `postMaturityMode: true`, so this function is never reached with `now <= maturity`
 * in that mode.
 */
export function lifAt({
  now,
  maturity,
  maxLif,
  postMaturityMode
}: {
  now: bigint;
  maturity: bigint;
  maxLif: bigint;
  postMaturityMode: boolean;
}): bigint {
  if (!postMaturityMode) {
    return maxLif;
  }
  const lif = WAD + ((maxLif - WAD) * (now - maturity)) / TIME_TO_MAX_LIF;
  return min(maxLif, lif);
}
