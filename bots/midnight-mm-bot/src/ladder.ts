import { TickLib } from '@morpho-org/midnight-sdk';

import type { MarketQuoteConfig } from './config';

const WAD_PER_BPS = 100_000_000_000_000n;

export function buildLadderTicks(config: MarketQuoteConfig, tickSpacing: number) {
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0)
    throw new Error(`invalid market tick spacing: ${tickSpacing}`);

  const targetRate = BigInt(config.targetRateBps) * WAD_PER_BPS;
  const halfSpread = (BigInt(config.spreadBps) * WAD_PER_BPS) / 2n;
  const range = BigInt(config.ladderRangeBps) * WAD_PER_BPS;
  const intervals = BigInt(config.ladderLevels - 1);
  const span = range - halfSpread;
  const toTick = (rate: bigint) =>
    TickLib.priceToTick(TickLib.rateToPrice(rate), BigInt(tickSpacing));
  const bids: bigint[] = [];
  const asks: bigint[] = [];

  for (let level = 0; level < config.ladderLevels; level++) {
    const index = BigInt(level);
    const lowerDistance = intervals === 0n ? halfSpread : range - (span * index) / intervals;
    const upperDistance = intervals === 0n ? halfSpread : halfSpread + (span * index) / intervals;
    bids.push(toTick(targetRate - lowerDistance));
    asks.push(toTick(targetRate + upperDistance));
  }

  const ticks = [...bids, ...asks];
  if (new Set(ticks).size !== ticks.length) throw new Error('duplicate snapped tick in ladder');

  return { bids, asks };
}
