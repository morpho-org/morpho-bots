import { botsHome, configFile, secretsFile, signerPolicyFile } from '@repo/home'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  },
  // The per-chain queue daemon (morpho-queued). One daemon per chain, domain-agnostic: every bot’s
  // `queue` stage relays tx/outcome records to it. It reads RPC + the signing key from its own
  // `queued` section of secrets.json (the key MOVED here from the bot sections; RPC is duplicated).
  // Optional per-chain tunables: MAX_FEE_GWEI, STUCK_BLOCKS, BACKOFF_*_BLOCKS, SEND_RPC_URL.
  queued: {
    defaults: { LOG_LEVEL: 'info' },
    chains: { '8453': {} }
  },
  // The signing agent is chain-less (one daemon serves every chain; per-chain policy lives in
  // signer-policy.json). Set SIGNER_SOCKET in the queued section to opt the daemon into the agent.
  signer: {
    defaults: { LOG_LEVEL: 'info' }
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
  },
  // The queue daemon (morpho-queued) is the SOLE local key reader (when SIGNER_SOCKET is unset). The
  // signing key MOVED here from the bot sections (only the key moves); RPC_URL is DUPLICATED per
  // chain (the bot sections keep theirs for the source/transform op stages). Set SIGNER_SOCKET here
  // instead of a key to sign through the agent.
  queued: {
    defaults: { LIQUIDATOR_PRIVATE_KEY: '0x…' },
    chains: { '8453': { RPC_URL: 'https://…' } }
  },
  // The signing agent’s key — the SOLE holder when the daemon runs with SIGNER_SOCKET set. This is
  // NOT read from LIQUIDATOR_PRIVATE_KEY; move the key here when adopting the agent.
  signer: {
    defaults: { SIGNER_PRIVATE_KEY: '0x…' }
  }
}

// A one-rule default-deny example the operator edits: allow only exec calls to the Executor on Base,
// value 0, under the fee/gas ceilings. `to` and `selectors` are placeholders — set `to` to your
// Executor address and the selector(s) to the exec entrypoint(s) you sign. Everything else is denied.
const EXAMPLE_SIGNER_POLICY = {
  version: 1,
  rules: [
    {
      name: 'blue-liquidation-base',
      chainIds: [8453],
      to: ['0x0000000000000000000000000000000000000000'],
      selectors: ['0x00000001'],
      maxValueWei: '0',
      maxFeePerGasWei: '300000000000',
      maxGasLimit: '15000000'
    }
  ]
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
  console.log(`\nNext: fill in ${secretsFile(home)} (kept chmod 600), then:`)
  console.log('  1. start the per-chain queue daemon (holds the key, owns submit/RBF):')
  console.log('       morpho-queued --chain 8453')
  console.log('  2. run the pipeline in a loop; the `queue` stage relays to the daemon:')
  console.log(
    '       while true; do morpho-bots blue unhealthy-positions | morpho-bots blue liquidate | morpho-bots blue queue; sleep 2; done'
  )
  console.log(
    `\nOptional: to run the keyless signing agent, edit ${signerPolicyPath} (set the Executor ` +
      'address + selectors), set SIGNER_PRIVATE_KEY in secrets.json, start `morpho-bots signer`, ' +
      'and set SIGNER_SOCKET in the queued section so the daemon signs through it.'
  )
  return 0
}
