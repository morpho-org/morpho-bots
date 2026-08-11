import { TickLib } from '@morpho-org/midnight-sdk'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n

/**
 * Converts an annual integer-BPS rate into Midnight's aligned fixed-term tick.
 * @param parameters - Annual rate, remaining term, and live market tick spacing.
 * @returns The lowest aligned protocol tick whose price represents the requested rate.
 * @remarks Callers must reject matured markets before supplying a non-positive remaining term.
 */
export const annualRateBpsToTick = (parameters: {
  rateBps: bigint
  timeToMaturity: bigint
  tickSpacing: bigint
}) => {
  const periodRateWad =
    (parameters.rateBps * (WAD / 10_000n) * parameters.timeToMaturity) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), parameters.tickSpacing)
}

/**
 * Preserves a strict bootstrap-buy/ladder-sell spread after protocol tick alignment.
 * @param parameters - Prospective bootstrap tick, relevant ladder sell ticks, and market spacing.
 * @returns The original buy tick when already separated, one spacing lower when rounding made the
 * nearest prices equal, or `undefined` when the inputs represent a genuine cross or no lower tick.
 * @remarks The one-tick adjustment handles quantization only; it never conceals a configured cross.
 */
export const separateBootstrapBuyTick = (parameters: {
  buyTick: bigint
  ladderSellTicks: readonly bigint[]
  tickSpacing: bigint
}) => {
  const lowestLadderSellTick = parameters.ladderSellTicks.reduce<bigint | undefined>(
    (lowest, tick) => (lowest === undefined || tick < lowest ? tick : lowest),
    undefined
  )
  if (lowestLadderSellTick === undefined || parameters.buyTick < lowestLadderSellTick) {
    return parameters.buyTick
  }
  if (parameters.buyTick !== lowestLadderSellTick || parameters.buyTick < parameters.tickSpacing) {
    return undefined
  }
  return parameters.buyTick - parameters.tickSpacing
}
