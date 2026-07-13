import { botsHome, configFile, secretsFile, signerPolicyFile } from '@repo/home'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-var names as keys — the merge layer hands these straight to each bot's loadConfig, so the
// full knob list is each bot's src/config.ts. "_" keys are documentation; the bots ignore them.
const EXAMPLE_CONFIG = {
  _readme:
    'Non-secret settings. Keys are the bots’ env-var names; per-chain overlays under chains.<id> beat defaults; process env beats everything. LIQUIDATOR_ADDRESS is act’s skim recipient and simulate `from`; morpho-queued verifies it against morpho-signer at startup.',
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
        ZEROX_API_KEY: '',
        ONEINCH_API_KEY: ''
      }
    }
  }
}

// One signer process authorizes one Executor on one chain. Zero value and the Executor's
// exec_606BaXt selector are hard-coded signer invariants.
const EXAMPLE_SIGNER_POLICY = {
  chainId: 8453,
  executor: '0x0000000000000000000000000000000000000000',
  maxFeePerGasWei: '300000000000',
  maxGasLimit: '15000000',
  maxDataBytes: 65536
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
  for (const dir of ['locks', 'queued', 'blue/cache', 'midnight/cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }

  const swapConfigPath = join(home, 'blue', 'swap-config.json')
  const configJson = JSON.stringify(EXAMPLE_CONFIG, null, 2).replaceAll(
    '<home>/blue/swap-config.json',
    swapConfigPath
  )
  const signerPolicyPath = signerPolicyFile(home)
  const results = [
    [configFile(home), writeOnce(configFile(home), configJson + '\n')],
    [
      secretsFile(home),
      writeOnce(secretsFile(home), JSON.stringify(EXAMPLE_SECRETS, null, 2) + '\n', 0o600)
    ],
    [
      swapConfigPath,
      writeOnce(swapConfigPath, JSON.stringify(EXAMPLE_SWAP_CONFIG, null, 2) + '\n')
    ],
    [
      signerPolicyPath,
      writeOnce(signerPolicyPath, JSON.stringify(EXAMPLE_SIGNER_POLICY, null, 2) + '\n')
    ]
  ] as const

  for (const [path, outcome] of results) {
    console.log(`${outcome === 'created' ? 'created' : 'kept   '} ${path}`)
  }
  console.log(`\nNext: fill in ${secretsFile(home)} (kept chmod 600), export service env, then:`)
  console.log('  1. edit signer-policy.json and start the signing agent:')
  console.log('       SIGNER_PRIVATE_KEY=0x… morpho-signer')
  console.log('  2. start the per-chain queue daemon (owns submit/RBF):')
  console.log('       morpho-queued serve --chain 8453')
  console.log('  3. run the pipeline in a loop; `submit` relays to the daemon:')
  console.log(
    '       set -o pipefail; while true; do morpho-bots blue unhealthy-positions | morpho-bots blue liquidate | morpho-queued submit --chain 8453 || exit $?; sleep 2; done'
  )
  console.log(`\nThe signing policy is ${signerPolicyPath}; signing is default-deny.`)
  return 0
}
