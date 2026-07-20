import { describe, expect, it } from 'bun:test';

import {
  assertOffersWithinDeviation,
  fetchReferenceMarketPrice,
  parseReferenceMarketPrice
} from '../src/market-price';

const MARKET_ID = `0x${'11'.repeat(32)}`;

describe('parseReferenceMarketPrice', () => {
  it('returns the bigint midpoint of the best bid and ask', () => {
    expect(
      parseReferenceMarketPrice({
        data: {
          bids: [{ price: '100' }, { price: '99' }],
          asks: [{ price: '104' }, { price: '105' }]
        }
      })
    ).toBe(102n);
  });

  it('rejects missing or malformed sides', () => {
    for (const response of [
      {},
      { data: { bids: [], asks: [{ price: '100' }] } },
      { data: { bids: [{ price: '100' }], asks: [] } },
      { data: { bids: [{ price: '0' }], asks: [{ price: '100' }] } },
      { data: { bids: [{ price: '1.5' }], asks: [{ price: '100' }] } },
      { data: { bids: [{ price: '100' }], asks: [{ price: '-1' }] } }
    ]) {
      expect(() => parseReferenceMarketPrice(response)).toThrow();
    }
  });
});

describe('fetchReferenceMarketPrice', () => {
  it('fetches the exact Router book URL with an AbortSignal', async () => {
    let requestedUrl: string | undefined;
    let requestedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedSignal = init?.signal;
        return Response.json({ data: { bids: [{ price: '100' }], asks: [{ price: '104' }] } });
      },
      { preconnect() {} }
    );

    expect(
      await fetchReferenceMarketPrice({
        apiUrl: 'https://router.example/v1/',
        marketId: MARKET_ID,
        timeoutMs: 2500,
        fetcher
      })
    ).toBe(102n);
    expect(requestedUrl).toBe(`https://router.example/v1/books/${MARKET_ID}`);
    expect(requestedSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects non-success HTTP responses', async () => {
    const fetcher: typeof fetch = Object.assign(
      async () =>
        Response.json(
          { data: { bids: [{ price: '100' }], asks: [{ price: '104' }] } },
          { status: 503 }
        ),
      { preconnect() {} }
    );

    await expect(
      fetchReferenceMarketPrice({
        apiUrl: 'https://router.example/v1',
        marketId: MARKET_ID,
        timeoutMs: 2500,
        fetcher
      })
    ).rejects.toThrow('Router book request failed with HTTP 503');
  });

  it('rejects invalid JSON responses', async () => {
    const fetcher: typeof fetch = Object.assign(async () => new Response('{', { status: 200 }), {
      preconnect() {}
    });

    await expect(
      fetchReferenceMarketPrice({
        apiUrl: 'https://router.example/v1',
        marketId: MARKET_ID,
        timeoutMs: 2500,
        fetcher
      })
    ).rejects.toThrow();
  });
});

describe('assertOffersWithinDeviation', () => {
  it('accepts offers exactly on the configured boundary', () => {
    expect(() => assertOffersWithinDeviation([90n, 110n], 100n, 1000)).not.toThrow();
  });

  it('rejects the whole ladder when any offer exceeds the boundary', () => {
    expect(() => assertOffersWithinDeviation([100n, 111n, 99n], 100n, 1000)).toThrow(
      'offer price 111 exceeds 1000 bps from Router midpoint 100'
    );
  });
});
