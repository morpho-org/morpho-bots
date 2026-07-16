// Deploy-only Railway entrypoint for CI. Unlike deploy-railway-{blue-liq,midnight-liq}.ts, this sets no
// variables or secrets and creates nothing — it assumes the environment is already provisioned
// (services + vars + secrets set by the full scripts, run once per environment) and only ships the
// checked-out working tree. This keeps signer keys and other secrets out of CI; the only credential
// CI needs is a RAILWAY_TOKEN scoped to the target project + environment.
//
// Usage:
//   BOT=blue-liq RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT=staging RAILWAY_TOKEN=… \
//     bun run --filter @repo/deploy deploy:railway

import { resolve } from 'node:path'

import { BOTS, isBotName } from './manifest'
import { deploymentFailed, Railway, required } from './railway'

const env = Bun.env
// BOT names the deployable bot to ship (blue-liq | midnight-liq) — the deploy-layer identity. It is
// NOT the container's runtime BOT (the CLI protocol domain blue | midnight, set on each Railway
// service by the full provisioning scripts); this script only re-ships code, never touches that var.
const bot = required(env, 'BOT')
if (!isBotName(bot)) {
  throw new Error(`Unknown BOT "${bot}". Expected one of: ${Object.keys(BOTS).join(', ')}`)
}

const environment = env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const railway = new Railway(
  required(env, 'RAILWAY_PROJECT_ID'),
  environment,
  resolve(import.meta.dir, '..', '..')
)

await railway.initialize()

// Kick off every service's build first, then poll — Railway builds them concurrently. A service
// that doesn't exist fails loud here, which is the correct signal that the environment was never
// provisioned (run the full deploy-railway-{bot}.ts script once before deploy-only CI can ship).
const { services } = BOTS[bot]
for (const service of services) await railway.deploy(service)

const statuses = new Map<string, string>()
for (const service of services) statuses.set(service, await railway.waitForDeploy(service))

console.log(`\nDeployment status (${bot} → ${environment})`)
for (const [service, status] of statuses) console.log(`  ${service}: ${status}`)
process.exitCode = [...statuses.values()].some(deploymentFailed) ? 1 : 0
