import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { botsHome, configFile, secretsFile } from '../home'

// Env-var names as keys — the merge layer hands these straight to each bot's loadConfig, so the
// full knob list is each bot's src/config.ts. "_" keys are documentation; the bots ignore them.
const EXAMPLE_CONFIG = {
  _readme:
    'Non-secret settings. Keys are the bots’ env-var names; per-chain overlays under chains.<id> beat defaults; process env beats everything. LIQUIDATOR_ADDRESS is act’s skim recipient and simulate `from` — it MUST match the address derived from LIQUIDATOR_PRIVATE_KEY (secrets.json), or seized funds skim to a wallet the queue can’t sign for.',
  blue: {
    defaults: { LOG_LEVEL: 'info' },
    chains: {
      '8453': { LIQUIDATOR_ADDRESS: '0x…', SWAP_CONFIG_PATH: '<home>/blue/swap-config.json' }
    }
  },
  midnight: {
    defaults: { LOG_LEVEL: 'info' },
    chains: { '8453': { LIQUIDATOR_ADDRESS: '0x…' } }
  }
}

const EXAMPLE_SECRETS = {
  _readme:
    'Secrets (chmod 600). RPC provider URLs usually embed API keys, so they belong here too.',
  blue: {
    defaults: {},
    chains: {
      '8453': {
        RPC_URL: 'https://…',
        LIQUIDATOR_PRIVATE_KEY: '0x…',
        DATABASE_URL: 'postgres://…',
        ZEROX_API_KEY: ''
      }
    }
  },
  midnight: {
    defaults: {},
    chains: {
      '8453': {
        RPC_URL: 'https://…',
        LIQUIDATOR_PRIVATE_KEY: '0x…',
        ZEROX_API_KEY: '',
        ONEINCH_API_KEY: ''
      }
    }
  }
}

// A minimal per-collateral routing example; the maintained reference (live Base/Robinhood routes)
// is packages/blue-liquidation/configs/example.json.
const EXAMPLE_SWAP_CONFIG = {
  '8453': {
    '0x4200000000000000000000000000000000000006': {
      venue: 'uniswap-v3',
      router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      fee: 500,
      slippageBps: 100
    }
  }
}

function writeOnce(path: string, content: string, mode?: number): 'created' | 'kept' {
  if (existsSync(path)) return 'kept'
  writeFileSync(path, content, mode === undefined ? {} : { mode })
  return 'created'
}

/** Scaffolds the home dir with commented examples; never overwrites what already exists. */
export function runInit(): number {
  const home = botsHome()
  for (const dir of ['locks', 'blue/queue', 'blue/cache', 'midnight/queue', 'midnight/cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }

  const swapConfigPath = join(home, 'blue', 'swap-config.json')
  const configJson = JSON.stringify(EXAMPLE_CONFIG, null, 2).replaceAll(
    '<home>/blue/swap-config.json',
    swapConfigPath
  )
  const results = [
    [configFile(home), writeOnce(configFile(home), configJson + '\n')],
    [
      secretsFile(home),
      writeOnce(secretsFile(home), JSON.stringify(EXAMPLE_SECRETS, null, 2) + '\n', 0o600)
    ],
    [swapConfigPath, writeOnce(swapConfigPath, JSON.stringify(EXAMPLE_SWAP_CONFIG, null, 2) + '\n')]
  ] as const

  for (const [path, outcome] of results) {
    console.log(`${outcome === 'created' ? 'created' : 'kept   '} ${path}`)
  }
  console.log(`\nNext: fill in ${secretsFile(home)} (kept chmod 600), then run the pipeline e.g.:`)
  console.log(
    '  morpho-bots blue unhealthy-positions | morpho-bots blue liquidate | morpho-bots blue queue'
  )
  console.log(
    '  while true; do morpho-bots blue unhealthy-positions | morpho-bots blue liquidate | morpho-bots blue queue; sleep 2; done'
  )
  return 0
}
