import type { KillSwitchBotConfig } from '../../src/schema'

// Typed fixture exercising the config loader. The operator-facing sample `src/config.ts` (with the
// documented walkthrough) lands in Phase 8 (CRTR-2557); Phase 1 validates against this fixture.
// All addresses are placeholders, not any real curator vault or oracle.
export const config: KillSwitchBotConfig = {
  signer: { privateKeyEnv: 'SIGNER_PRIVATE_KEY' },
  chain: {
    id: 1,
    rpc: { http: ['https://rpc.example.com/primary', 'https://rpc.example.com/fallback'] },
    pollIntervalMs: 10_000,
    walletBalanceFloor: '0.05'
  },
  vault: { address: '0x1234567890123456789012345678901234567890' },
  oracleConfigs: [
    {
      morphoOracleAddress: '0xaBcDeF1234567890aBcDeF1234567890AbCdEf12',
      stalenessSeconds: 1800,
      deviationBps: 50,
      stalenessAdapter: 'chainlink',
      stalenessSpec: { feeds: ['0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'] },
      referenceAdapter: 'chainlink-direct',
      referenceSpec: { feed: '0xdEAd00000000000000000000000000000000bEEF' }
    }
  ],
  dryRun: false
}
