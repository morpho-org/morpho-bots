import { resolve } from 'node:path'

import { assertPrivateKey, deploymentFailed, Railway, required, signerPolicy } from './railway'

type Chain = { chainId: number; service: string }

const env = Bun.env
const chains: Chain[] = [
  { chainId: 8453, service: 'bot-8453' },
  { chainId: 4663, service: 'bot-4663' }
]
const railway = new Railway(
  required(env, 'RAILWAY_PROJECT_ID'),
  env.RAILWAY_ENVIRONMENT?.trim() || 'production',
  resolve(import.meta.dir, '..', '..')
)

function suffixed(name: string, chainId: number): string | undefined {
  return env[`${name}_${chainId}`]?.trim() || undefined
}

const deployments = chains.map(chain => {
  const rpcUrl = suffixed('RPC_URL', chain.chainId)
  if (!rpcUrl) throw new Error(`Missing required env var: RPC_URL_${chain.chainId}`)
  const privateKey = suffixed('SIGNER_PRIVATE_KEY', chain.chainId) ?? env.SIGNER_PRIVATE_KEY?.trim()
  if (!privateKey) {
    throw new Error(
      `Missing required env var: SIGNER_PRIVATE_KEY_${chain.chainId} (or SIGNER_PRIVATE_KEY)`
    )
  }
  assertPrivateKey(privateKey)
  const liquidatorAddress =
    suffixed('LIQUIDATOR_ADDRESS', chain.chainId) ?? env.LIQUIDATOR_ADDRESS?.trim()
  if (!liquidatorAddress) {
    throw new Error(
      `Missing required env var: LIQUIDATOR_ADDRESS_${chain.chainId} (or LIQUIDATOR_ADDRESS)`
    )
  }
  return {
    ...chain,
    rpcUrl,
    rindexerRpcUrl: suffixed('RINDEXER_RPC_URL', chain.chainId) ?? rpcUrl,
    privateKey,
    executor: suffixed('EXECUTOOOR_ADDRESS', chain.chainId) ?? required(env, 'EXECUTOOOR_ADDRESS'),
    liquidatorAddress,
    zeroxKey: suffixed('ZEROX_API_KEY', chain.chainId) ?? env.ZEROX_API_KEY?.trim(),
    oneinchKey: suffixed('ONEINCH_API_KEY', chain.chainId) ?? env.ONEINCH_API_KEY?.trim()
  }
})

await railway.initialize()
const postgres = await railway.ensurePostgres()
const databaseUrl = 'DATABASE_URL=${{' + postgres + '.DATABASE_URL}}'

await railway.ensureService('rindexer')
await railway.setVariables('rindexer', {
  RAILWAY_DOCKERFILE_PATH: 'deploy/blue-rindexer/Dockerfile',
  PROJECT_PATH: '/app/project_path',
  DATABASE_URL: '${{' + postgres + '.DATABASE_URL}}'
})
await railway.setSecrets(
  'rindexer',
  Object.fromEntries(
    deployments.map(chain => [`RINDEXER_RPC_URL_${chain.chainId}`, chain.rindexerRpcUrl])
  )
)
await railway.deploy('rindexer')

// One BetterStack source for blue, shared across its chains (distinguished by bot/chainId fields).
// Host is a plain var; the token is a secret. Both are optional — forwarding is off when unset.
const betterstackHost = env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = env.BETTERSTACK_SOURCE_TOKEN?.trim()

for (const chain of deployments) {
  await railway.ensureService(chain.service)
  await railway.ensureVolume(chain.service, '/data')
  await railway.setVariables(chain.service, {
    BOT: 'blue',
    CHAIN_ID: String(chain.chainId),
    TICK_INTERVAL_S: env.TICK_INTERVAL_S?.trim() || '2',
    RAILWAY_DOCKERFILE_PATH: 'deploy/Dockerfile',
    SWAP_CONFIG_PATH: '/data/morpho-bots/blue/swap-config.json',
    LOG_LEVEL: 'info',
    LIQUIDATOR_ADDRESS: chain.liquidatorAddress,
    EXECUTOOOR_ADDRESS: chain.executor,
    SIGNER_POLICY_JSON: signerPolicy(chain.chainId, chain.executor),
    DATABASE_URL: databaseUrl.slice('DATABASE_URL='.length),
    ...(betterstackHost ? { BETTERSTACK_INGESTING_HOST: betterstackHost } : {})
  })
  await railway.setSecrets(chain.service, {
    RPC_URL: chain.rpcUrl,
    SIGNER_PRIVATE_KEY: chain.privateKey,
    ZEROX_API_KEY: chain.zeroxKey,
    ONEINCH_API_KEY: chain.oneinchKey,
    BETTERSTACK_SOURCE_TOKEN: betterstackToken
  })
  await railway.deploy(chain.service)
}

const rindexerStatus = await railway.waitForDeploy('rindexer')
const statuses = new Map<string, string>()
for (const chain of deployments) {
  statuses.set(chain.service, await railway.waitForDeploy(chain.service))
}

console.log(`\nDeployment status\n  rindexer: ${rindexerStatus}`)
for (const [service, status] of statuses) console.log(`  ${service}: ${status}`)
console.log("\nUpload each chain's swap config to /data/morpho-bots/blue/swap-config.json.")
console.log('Robinhood remains detection-only until it has a route and deployed Executor.')
process.exitCode =
  deploymentFailed(rindexerStatus) || [...statuses.values()].some(deploymentFailed) ? 1 : 0
