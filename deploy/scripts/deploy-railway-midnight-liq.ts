import { resolve } from 'node:path'

import { BOTS } from './manifest'
import { assertPrivateKey, deploymentFailed, Railway, required, signerPolicy } from './railway'

const env = Bun.env
const { chainId, service } = BOTS['midnight-liq'].chains[0]
const railway = new Railway(
  required(env, 'RAILWAY_PROJECT_ID'),
  env.RAILWAY_ENVIRONMENT?.trim() || 'production',
  resolve(import.meta.dir, '..', '..')
)

const privateKey = required(env, 'SIGNER_PRIVATE_KEY')
assertPrivateKey(privateKey)
const zeroxKey = env.ZEROX_API_KEY?.trim()
const oneinchKey = env.ONEINCH_API_KEY?.trim()
const lifiKey = env.LIFI_API_KEY?.trim()
// LiFi works keyless, so ENABLE_LIFI=true turns it on without a key (a key only raises rate limits).
const enableLifi = env.ENABLE_LIFI?.trim().toLowerCase() === 'true'
const allowBadDebtOnly = env.ALLOW_BAD_DEBT_ONLY?.trim().toLowerCase() === 'true'
// Optional BetterStack forwarding: host is a plain var, token is a secret. Off when unset.
const betterstackHost = env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = env.BETTERSTACK_SOURCE_TOKEN?.trim()
if (!zeroxKey && !oneinchKey && !lifiKey && !enableLifi && !allowBadDebtOnly) {
  throw new Error(
    'Set ENABLE_LIFI=true or LIFI_API_KEY / ZEROX_API_KEY / ONEINCH_API_KEY, or ALLOW_BAD_DEBT_ONLY=true to deploy bad-debt-only.'
  )
}

await railway.initialize()
await railway.ensureService(service)
await railway.ensureVolume(service, '/data')
const executor = required(env, 'EXECUTOOOR_ADDRESS')
await railway.setVariables(service, {
  BOT: 'midnight',
  CHAIN_ID: String(chainId),
  TICK_INTERVAL_S: env.TICK_INTERVAL_S?.trim() || '2',
  RAILWAY_DOCKERFILE_PATH: 'deploy/Dockerfile',
  LOG_LEVEL: 'info',
  LIQUIDATOR_ADDRESS: required(env, 'LIQUIDATOR_ADDRESS'),
  EXECUTOOOR_ADDRESS: executor,
  SIGNER_POLICY_JSON: signerPolicy(chainId, executor),
  ...(enableLifi ? { ENABLE_LIFI: 'true' } : {}),
  ...(allowBadDebtOnly ? { ALLOW_BAD_DEBT_ONLY: 'true' } : {}),
  ...(betterstackHost ? { BETTERSTACK_INGESTING_HOST: betterstackHost } : {})
})
await railway.setSecrets(service, {
  RPC_URL: required(env, 'RPC_URL'),
  SIGNER_PRIVATE_KEY: privateKey,
  ZEROX_API_KEY: zeroxKey,
  ONEINCH_API_KEY: oneinchKey,
  LIFI_API_KEY: lifiKey,
  BETTERSTACK_SOURCE_TOKEN: betterstackToken
})
await railway.deploy(service)

const status = await railway.waitForDeploy(service)
console.log(`\nDeployment status\n  ${service}: ${status}`)
console.log('\nThe bot needs a funded liquidator key and a working RPC endpoint.')
if (!zeroxKey && !oneinchKey) {
  console.log('Bad-debt-only mode is active; add a venue key to enable swap liquidations.')
}
process.exitCode = deploymentFailed(status) ? 1 : 0
