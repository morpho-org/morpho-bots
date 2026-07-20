import { TickLib } from '@morpho-org/midnight-sdk'

const WAD_PER_BPS = 100_000_000_000_000n
const SECONDS_PER_YEAR = 31_536_000n

export function aprBpsToTick({
  aprBps,
  timeToMaturity,
  tickSpacing
}: {
  aprBps: number
  timeToMaturity: bigint
  tickSpacing: number
}) {
  if (timeToMaturity <= 0n) throw new Error('Market has matured')
  if (!Number.isSafeInteger(aprBps) || aprBps < 0) throw new Error('APR bps must be non-negative')
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0)
    throw new Error('Invalid tick spacing')

  const apr = BigInt(aprBps) * WAD_PER_BPS
  const periodRate = (apr * timeToMaturity) / SECONDS_PER_YEAR
  return TickLib.priceToTick(TickLib.rateToPrice(periodRate), BigInt(tickSpacing))
}
