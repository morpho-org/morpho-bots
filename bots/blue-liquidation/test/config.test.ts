import { describe, expect, it } from 'bun:test';

import { getAddress } from 'viem';
import { base } from 'viem/chains';

import type { ChainConfig, Config, QuotingConfig } from '../src/config';
import { loadConfig } from '../src/config';

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const KEY = `0x${'1'.repeat(64)}`;
const COLLATERAL = '0x4200000000000000000000000000000000000006';

// A venue API key is present by default so most cases exercise the armed (not detection-only)
// posture.
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    CHAIN_ID: String(base.id),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_PRIVATE_KEY: KEY,
    ZEROX_API_KEY: 'zx-key',
    ...overrides
  };
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) {
      delete env[k];
    }
  }
  return env;
}

describe('loadConfig', () => {
  it('loads a valid Base config with the canonical Morpho singleton', () => {
    const config = loadConfig(baseEnv());
    expect(config.chainId).toBe(base.id);
    expect(config.morpho).toBe(MORPHO);
    expect(config.chain.id).toBe(base.id);
    expect(config.rpcUrl).toBe('https://base.example');
    // Executor address is derived from the deterministic CREATE2 factory when not overridden.
    expect(config.executooorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(config.venues.enabled).toEqual(['0x']);
    expect(config.venues.slippageBps).toBe(100);
    expect(config.venues.excludeCollaterals).toEqual([]);
    expect(config.venues.zeroxBaseUrl).toBeUndefined();
  });

  it('resolves the Robinhood chain with its own (non-canonical) Morpho singleton', () => {
    const config = loadConfig(baseEnv({ CHAIN_ID: '4663' }));
    expect(config.chainId).toBe(4663);
    expect(config.chain.id).toBe(4663);
    // Robinhood's singleton is at a DIFFERENT address than Base's canonical 0xBBBB…
    expect(config.morpho).toBe(getAddress('0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010'));
    expect(config.morpho).not.toBe(MORPHO);
  });

  it('fails loud on each missing required var', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: undefined }))).toThrow(/CHAIN_ID/);
    expect(() => loadConfig(baseEnv({ RPC_URL: undefined }))).toThrow(/RPC_URL/);
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    );
  });

  it('rejects an unsupported chain id', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '1' }))).toThrow(/Unsupported CHAIN_ID/);
  });

  it('parses quoting tunables with safe defaults', () => {
    const config: Config = loadConfig(baseEnv());
    const quoting: QuotingConfig = config.quoting;
    expect(quoting.maxRouteImpactBps).toBe(500);
    expect(quoting.httpRps).toBe(2);
    expect(quoting.backoffBaseBlocks).toBe(2n);
  });

  it('honors an injected chain map (so a new chain is wired in one place)', () => {
    const chainMap: Record<number, ChainConfig> = {
      [base.id]: { chain: base, morpho: MORPHO }
    };
    expect(loadConfig(baseEnv(), { chainMap }).morpho).toBe(MORPHO);
    // A chain absent from the injected map is rejected even if it is a real chain id.
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '10' }), { chainMap })).toThrow(/Unsupported/);
  });

  it('rejects a malformed private key', () => {
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xdeadbeef' }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    );
  });

  it('enables 1inch on its key alone', () => {
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: undefined, ONEINCH_API_KEY: '1inch-key' }));
    expect(config.venues.enabled).toEqual(['1inch']);
  });

  it('enables lifi FIRST (cold-cache default order) when its key joins the others', () => {
    const config = loadConfig(baseEnv({ ONEINCH_API_KEY: '1inch-key', LIFI_API_KEY: 'lifi-key' }));
    expect(config.venues.enabled).toEqual(['lifi', '0x', '1inch']);
  });

  it('enables lifi keyless via ENABLE_LIFI=true (no LIFI_API_KEY)', () => {
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: undefined, ENABLE_LIFI: 'true' }));
    expect(config.venues.enabled).toEqual(['lifi']);
  });

  it('throws when no venue is enabled and detection-only is not opted into', () => {
    expect(() => loadConfig(baseEnv({ ZEROX_API_KEY: undefined }))).toThrow(/No venues enabled/);
  });

  it('boots detection-only (no enabled venues) when ALLOW_DETECTION_ONLY=true', () => {
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: undefined, ALLOW_DETECTION_ONLY: 'true' }));
    expect(config.venues.enabled).toEqual([]);
  });

  it('throws on a non-boolean ALLOW_DETECTION_ONLY', () => {
    expect(() => loadConfig(baseEnv({ ALLOW_DETECTION_ONLY: 'yes' }))).toThrow(
      /ALLOW_DETECTION_ONLY must be "true" or "false"/
    );
  });

  it('parses SLIPPAGE_BPS and EXCLUDE_COLLATERALS, failing loud on a bad address', () => {
    expect(loadConfig(baseEnv({ SLIPPAGE_BPS: '250' })).venues.slippageBps).toBe(250);
    const config = loadConfig(baseEnv({ EXCLUDE_COLLATERALS: ` ${COLLATERAL} , ${MORPHO}` }));
    expect(config.venues.excludeCollaterals).toEqual([getAddress(COLLATERAL), MORPHO]);
    expect(() => loadConfig(baseEnv({ EXCLUDE_COLLATERALS: '0x123' }))).toThrow(
      /EXCLUDE_COLLATERALS contains an invalid address/
    );
  });

  it('validates venue base-URL overrides', () => {
    const config = loadConfig(baseEnv({ LIFI_API_KEY: 'k', LIFI_BASE_URL: 'https://li.example' }));
    expect(config.venues.lifiBaseUrl).toBe('https://li.example');
    expect(() => loadConfig(baseEnv({ ZEROX_BASE_URL: 'not a url' }))).toThrow(
      /ZEROX_BASE_URL is not a valid URL/
    );
  });

  it('parses probe knobs with defaults, and PROBE_LADDER fails loud on a malformed element', () => {
    const config = loadConfig(baseEnv());
    expect(config.probe.staleMs).toBe(600_000);
    expect(config.probe.httpRps).toBe(1);
    expect(config.probe.ladderWholeTokens).toEqual(['0.01', '0.1', '1', '10', '100']);
    expect(loadConfig(baseEnv({ PROBE_LADDER: '0.5, 5, 50' })).probe.ladderWholeTokens).toEqual([
      '0.5',
      '5',
      '50'
    ]);
    expect(() => loadConfig(baseEnv({ PROBE_LADDER: '1,0,10' }))).toThrow(
      /PROBE_LADDER must be comma-separated positive numbers/
    );
  });

  it('defaults the discovery endpoint to the public Morpho GraphQL API and validates overrides', () => {
    expect(loadConfig(baseEnv()).discovery.apiUrl).toBe('https://api.morpho.org/graphql');
    expect(
      loadConfig(baseEnv({ MORPHO_API_URL: 'https://staging.example/graphql' })).discovery.apiUrl
    ).toBe('https://staging.example/graphql');
    expect(() => loadConfig(baseEnv({ MORPHO_API_URL: 'not a url' }))).toThrow(
      /MORPHO_API_URL is not a valid URL/
    );
  });

  it('defaults HEALTH_FACTOR_LTE to 1.02 and throws below the 1.0 floor (never a silent clamp)', () => {
    expect(loadConfig(baseEnv()).discovery.healthFactorLte).toBe(1.02);
    expect(loadConfig(baseEnv({ HEALTH_FACTOR_LTE: '1.1' })).discovery.healthFactorLte).toBe(1.1);
    expect(() => loadConfig(baseEnv({ HEALTH_FACTOR_LTE: '0.9' }))).toThrow(
      /HEALTH_FACTOR_LTE must be >= 1/
    );
    expect(() => loadConfig(baseEnv({ HEALTH_FACTOR_LTE: 'fast' }))).toThrow(
      /HEALTH_FACTOR_LTE must be a positive number/
    );
  });
});
