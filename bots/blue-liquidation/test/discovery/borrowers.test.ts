import { describe, expect, it } from 'bun:test';

import type { Logger } from '@repo/bot-kit';

import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';

import type { FetchPositionPage } from '../../src/discovery/borrowers';
import {
  createGraphqlCandidateSource,
  discoverBorrowerIds,
  discoverCandidates,
  PAGE_LIMIT
} from '../../src/discovery/borrowers';
import type { MarketParams } from '../../src/market';
import type { MarketParamsResolver } from '../../src/state/market-params';

const MARKET: Hex = `0x${'a'.repeat(64)}`;
const MARKET_2: Hex = `0x${'b'.repeat(64)}`;
const BORROWER = '0x1111111111111111111111111111111111111111';
const BORROWER_2 = '0x2222222222222222222222222222222222222222';
const URL = 'https://api.example/graphql';

// Minimal raw response row — discovery only reads market.marketId + user.address (params come from
// idToMarketParams and the lens re-reads all position state fresh on-chain).
const row = (marketId: unknown, address: unknown) => ({
  market: { marketId },
  user: { address }
});

const params = (loanToken: Address): MarketParams => ({
  loanToken,
  collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
  oracle: getAddress('0x3333333333333333333333333333333333333333'),
  irm: getAddress('0x4444444444444444444444444444444444444444'),
  lltv: 860000000000000000n
});

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields });
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  };
  return { logger, events };
}

// One full page (PAGE_LIMIT rows of one repeated pair) — exercises the skip sequence without
// materializing distinct addresses.
const fullPage = (marketId: Hex, address: string) => ({
  items: Array.from({ length: PAGE_LIMIT }, () => row(marketId, address)),
  countTotal: null
});

describe('discoverBorrowerIds', () => {
  it('paginates by skip until a partial page, de-duping across pages', async () => {
    const { logger } = spyLogger();
    const skips: number[] = [];
    const fetchPage: FetchPositionPage = async skip => {
      skips.push(skip);
      if (skip === 0) {
        return fullPage(MARKET, BORROWER);
      }
      return { items: [row(MARKET, BORROWER), row(MARKET_2, BORROWER_2)], countTotal: null };
    };
    const { pairs, rawRows, malformed } = await discoverBorrowerIds(fetchPage, { logger });
    expect(skips).toEqual([0, PAGE_LIMIT]);
    expect(rawRows).toBe(PAGE_LIMIT + 2);
    expect(malformed).toBe(0);
    // The full page's repeated pair and the second page's duplicate collapse to two distinct pairs.
    expect(pairs).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) },
      { marketId: MARKET_2, borrower: getAddress(BORROWER_2) }
    ]);
  });

  it('stops at the server-reported countTotal even on a full page', async () => {
    const { logger } = spyLogger();
    let calls = 0;
    const fetchPage: FetchPositionPage = async () => {
      calls += 1;
      return { ...fullPage(MARKET, BORROWER), countTotal: PAGE_LIMIT };
    };
    await discoverBorrowerIds(fetchPage, { logger });
    expect(calls).toBe(1);
  });

  it('lowercases market ids and checksums borrowers; malformed rows are counted, not fatal', async () => {
    const { logger } = spyLogger();
    const fetchPage: FetchPositionPage = async () => ({
      items: [
        row(`0x${'A'.repeat(64)}`, BORROWER.toUpperCase().replace('0X', '0x')),
        row('0xdead', BORROWER), // not bytes32
        row(BORROWER, BORROWER), // 20-byte hex is not a market id
        row(MARKET_2, 'not-an-address'),
        { market: null, user: { address: BORROWER } },
        { user: { address: BORROWER } },
        'not-an-object'
      ],
      countTotal: null
    });
    const { pairs, malformed } = await discoverBorrowerIds(fetchPage, { logger });
    expect(pairs).toEqual([{ marketId: MARKET, borrower: getAddress(BORROWER) }]);
    expect(malformed).toBe(6);
  });

  it('logs discover.max_pages loud at the runaway backstop instead of silently truncating', async () => {
    const { logger, events } = spyLogger();
    const fetchPage: FetchPositionPage = async skip => ({
      items: fullPage(MARKET, BORROWER).items,
      // Always report more rows beyond this page so the loop would keep walking without the cap.
      countTotal: skip + PAGE_LIMIT * 2
    });
    await discoverBorrowerIds(fetchPage, { logger, maxPages: 2 });
    const warn = events.find(e => e.event === 'discover.max_pages');
    expect(warn?.level).toBe('warn');
    expect(warn?.fields?.cap).toBe(2);
    expect(warn?.fields?.pages).toBe(2);
  });

  it('caps at maxCandidates and logs discover.oversized loud on an oversized full page', async () => {
    const { logger, events } = spyLogger();
    // A FULL page of distinct pairs that reports more rows beyond it: neither partial-page exhaustion
    // (items.length == PAGE_LIMIT) nor countTotal would stop the walk, so only the row cap can — which
    // is what `calls === 1` proves. Models the real bug: the API returns the whole universe in one
    // oversized page, slipping under the page-count backstop.
    const items = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      row(MARKET, `0x${(i + 1).toString(16).padStart(40, '0')}`)
    );
    let calls = 0;
    const fetchPage: FetchPositionPage = async skip => {
      calls += 1;
      return { items, countTotal: skip + PAGE_LIMIT * 2 };
    };
    const { pairs } = await discoverBorrowerIds(fetchPage, { logger, maxCandidates: 500 });
    // Truncated to the cap (worst-HF first via the query's ascending order), without fetching page 2.
    expect(pairs).toHaveLength(500);
    expect(calls).toBe(1);
    const warn = events.find(e => e.event === 'discover.oversized');
    expect(warn?.level).toBe('warn');
    expect(warn?.fields?.cap).toBe(500);
    expect(warn?.fields?.collected).toBe(500);
  });
});

describe('discoverCandidates', () => {
  const resolver =
    (known: Partial<Record<Hex, MarketParams>>): MarketParamsResolver =>
    async ids => {
      const out = new Map<Hex, MarketParams>();
      for (const id of ids) {
        const p = known[id];
        if (p) {
          out.set(id, p);
        }
      }
      return out;
    };

  it('joins pairs to on-chain params and drops unresolved ids with a loud warn', async () => {
    const { logger, events } = spyLogger();
    const loan = getAddress('0x5555555555555555555555555555555555555555');
    const fetchPage: FetchPositionPage = async () => ({
      items: [row(MARKET, BORROWER), row(MARKET_2, BORROWER_2)],
      countTotal: 2
    });
    const candidates = await discoverCandidates(fetchPage, resolver({ [MARKET]: params(loan) }), {
      logger
    });
    expect(candidates).toEqual([{ marketParams: params(loan), borrower: getAddress(BORROWER) }]);
    const dropped = events.find(e => e.event === 'discover.dropped');
    expect(dropped?.level).toBe('warn');
    expect(dropped?.fields?.unresolvedMarkets).toBe(1);
    expect(dropped?.fields?.unresolvedSample).toEqual([MARKET_2]);
  });

  it('emits no drop warn on a clean pass', async () => {
    const { logger, events } = spyLogger();
    const loan = getAddress('0x5555555555555555555555555555555555555555');
    const fetchPage: FetchPositionPage = async () => ({
      items: [row(MARKET, BORROWER)],
      countTotal: 1
    });
    await discoverCandidates(fetchPage, resolver({ [MARKET]: params(loan) }), { logger });
    expect(events.find(e => e.event === 'discover.dropped')).toBeUndefined();
    expect(events.find(e => e.event === 'discover.pass')?.fields?.candidates).toBe(1);
  });
});

describe('createGraphqlCandidateSource', () => {
  const page = (items: unknown[], countTotal = items.length) => ({
    data: { marketPositions: { pageInfo: { count: items.length, countTotal }, items } }
  });
  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it('POSTs the query document with chain/hf/pagination variables and parses the page', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 4663,
      healthFactorLte: 1.02,
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body as string) });
        return jsonResponse(page([row(MARKET, BORROWER)]));
      },
      sleep: async () => {}
    });
    const result = await fetchPage(2000);
    expect(result.items).toHaveLength(1);
    expect(result.countTotal).toBe(1);
    expect(requests[0]?.url).toBe(URL);
    expect(requests[0]?.body.query).toContain('marketPositions');
    expect(requests[0]?.body.query).toContain('marketListed: true');
    expect(requests[0]?.body.variables).toEqual({
      chainIds: [4663],
      hfLte: 1.02,
      first: PAGE_LIMIT,
      skip: 2000
    });
  });

  it('retries a 429 (honoring Retry-After) then succeeds', async () => {
    let attempts = 0;
    let slept = 0;
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({}, 429, { 'retry-after': '0' })
          : jsonResponse(page([]));
      },
      sleep: async () => {
        slept += 1;
      }
    });
    expect((await fetchPage(0)).items).toEqual([]);
    expect(attempts).toBe(2);
    expect(slept).toBe(1);
  });

  it('throws a 200-with-GraphQL-errors response after exactly one attempt (non-retryable)', async () => {
    let attempts = 0;
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse({ errors: [{ message: 'Cannot query field "nope"' }] });
      },
      sleep: async () => {}
    });
    await expect(fetchPage(0)).rejects.toThrow('GraphQL error: Cannot query field "nope"');
    expect(attempts).toBe(1);
  });

  it('still follows the HTTP retry policy when a 5xx body is not JSON', async () => {
    let attempts = 0;
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
          : jsonResponse(page([]));
      },
      sleep: async () => {}
    });
    expect((await fetchPage(0)).items).toEqual([]);
    expect(attempts).toBe(2);
  });

  it('surfaces a pageInfo.count / items mismatch as a parse error', async () => {
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl: async () =>
        jsonResponse({
          data: {
            marketPositions: {
              pageInfo: { count: 5, countTotal: 5 },
              items: [row(MARKET, BORROWER)]
            }
          }
        }),
      sleep: async () => {}
    });
    await expect(fetchPage(0)).rejects.toThrow('pageInfo.count 5 != items 1');
  });

  it('throws a parse error when data.marketPositions is missing', async () => {
    const fetchPage = createGraphqlCandidateSource({
      url: URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl: async () => jsonResponse({ data: {} }),
      sleep: async () => {}
    });
    await expect(fetchPage(0)).rejects.toThrow('parse error: missing items');
  });
});
