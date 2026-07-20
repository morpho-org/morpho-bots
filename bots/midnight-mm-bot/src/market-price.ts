type BookLevel = { price: string };
type Book = { data: { bids: BookLevel[]; asks: BookLevel[] } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositivePrice(value: unknown, side: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`Router book ${side} price must be a positive decimal bigint`);
  }
  return BigInt(value);
}

export function parseReferenceMarketPrice(value: unknown): bigint {
  if (!isRecord(value) || !isRecord(value.data))
    throw new Error('Router book response is malformed');

  const { bids, asks } = value.data as Partial<Book['data']>;
  if (!Array.isArray(bids) || bids.length === 0) throw new Error('Router book has no best bid');
  if (!Array.isArray(asks) || asks.length === 0) throw new Error('Router book has no best ask');

  const bestBid = isRecord(bids[0]) ? parsePositivePrice(bids[0].price, 'bid') : 0n;
  const bestAsk = isRecord(asks[0]) ? parsePositivePrice(asks[0].price, 'ask') : 0n;
  if (bestBid === 0n || bestAsk === 0n) throw new Error('Router book best level is malformed');
  return (bestBid + bestAsk) / 2n;
}

export function assertOffersWithinDeviation(
  offerPrices: bigint[],
  referencePrice: bigint,
  maxDeviationBps: number
) {
  for (const offerPrice of offerPrices) {
    const difference =
      offerPrice >= referencePrice ? offerPrice - referencePrice : referencePrice - offerPrice;
    if (difference * 10_000n > referencePrice * BigInt(maxDeviationBps)) {
      throw new Error(
        `offer price ${offerPrice} exceeds ${maxDeviationBps} bps from Router midpoint ${referencePrice}`
      );
    }
  }
}

export async function fetchReferenceMarketPrice({
  apiUrl,
  marketId,
  timeoutMs,
  fetcher = fetch
}: {
  apiUrl: string;
  marketId: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}): Promise<bigint> {
  const url = `${apiUrl.replace(/\/+$/, '')}/books/${marketId}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Router book request failed with HTTP ${response.status}`);
  return parseReferenceMarketPrice(await response.json());
}
