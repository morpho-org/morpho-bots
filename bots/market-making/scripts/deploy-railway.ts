/**
 * Reproducible Railway provisioning and deployment for the market-making bot.
 *
 * A full run creates the service, configures its package-owned Dockerfile, and uploads runtime
 * variables through stdin. CI sets DEPLOY_ONLY=true to re-ship the existing service without reading
 * or changing bot runtime configuration while still enforcing the reviewed Dockerfile. Both modes
 * wait for the newly created deployment to reach a terminal state and succeed only on Railway
 * `SUCCESS`.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

import { RailwayDeploymentError } from './railway-deployment.error'
import {
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  parseRailwayVolumes,
  selectNewRailwayDeployment,
  synchronizedOptionalRailwayVariables
} from './railway.utils'

const SERVICE = 'market-making'
const DOCKERFILE_PATH = 'bots/market-making/Dockerfile'
const STATE_MOUNT_PATH = '/state'
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const ENVIRONMENT = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DEPLOY_ONLY = /^(1|true)$/i.test(Bun.env.DEPLOY_ONLY?.trim() || '')
const PROJECT_ID = Bun.env.RAILWAY_PROJECT_ID?.trim()
if (!PROJECT_ID) {
  throw new RailwayDeploymentError('Missing required environment variable: RAILWAY_PROJECT_ID')
}

const requiredRuntimeVariableNames = [
  'CHAIN_ID',
  'RPC_URL',
  'REFERENCE_RPC_URL',
  'MAKER_PRIVATE_KEY',
  'MAKER_ADDRESS',
  'MIDNIGHT_ADDRESS',
  'LOAN_ASSET_ADDRESS',
  'RATIFIER_ADDRESS',
  'MORPHO_API_BASE_URL',
  'ROUTER_API_BASE_URL',
  'MARKET_IDS',
  'REFERENCE_MARKET_ID',
  'NATIVE_RESERVE_WEI',
  'MAXIMUM_LEND_EXPOSURE_ASSETS'
] as const

type RequiredRuntimeVariableName = (typeof requiredRuntimeVariableNames)[number]
type RuntimeVariable = readonly [name: string, value: string]

const required = (name: RequiredRuntimeVariableName) => {
  const value = Bun.env[name]?.trim()
  if (!value) throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)

  return value
}

const runtimeVariables = (): RuntimeVariable[] => {
  const requiredVariables = requiredRuntimeVariableNames.map(
    name => [name, required(name)] as const
  )
  const optionalVariables = synchronizedOptionalRailwayVariables(Bun.env)

  return [...requiredVariables, ...optionalVariables]
}

const assertCli = async () => {
  const { error } = await tryCatch(Promise.resolve($`railway --version`.quiet()))
  if (error) throw new RailwayDeploymentError('Railway CLI is unavailable')
}

const ensureContext = async () => {
  if (Bun.env.RAILWAY_TOKEN) return

  const { error } = await tryCatch(
    Promise.resolve($`railway link --project ${PROJECT_ID} --environment ${ENVIRONMENT}`.quiet())
  )
  if (error) throw new RailwayDeploymentError('Failed to select the Railway project environment')
}

const listServices = async () => {
  const { data, error } = await tryCatch(
    Promise.resolve(
      $`railway service list --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`
        .quiet()
        .text()
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to list Railway services')
  }

  return parseRailwayServices(data)
}

const ensureService = async () => {
  const services = await listServices()
  if (services.some(service => service.name === SERVICE)) return

  const { error } = await tryCatch(
    Promise.resolve($`railway add --service ${SERVICE} --json`.quiet())
  )
  if (error) throw new RailwayDeploymentError('Failed to create the Railway service')
}

const listVolumes = async () => {
  const { data, error } = await tryCatch(
    Promise.resolve(
      $`railway volume list --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`
        .quiet()
        .text()
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to list Railway volumes')
  }

  return parseRailwayVolumes(data)
}

const configuredStateVolume = async () => {
  const volumes = (await listVolumes()).filter(candidate => candidate.serviceName === SERVICE)
  if (volumes.length > 1) {
    throw new RailwayDeploymentError('Railway service has multiple attached volumes')
  }

  const volume = volumes[0]
  if (!volume) return undefined
  if (volume.isPendingDeletion) {
    throw new RailwayDeploymentError('Railway state volume is pending deletion')
  }
  if (volume.mountPath !== STATE_MOUNT_PATH) {
    throw new RailwayDeploymentError('Railway state volume uses an unexpected mount path')
  }

  return volume
}

const ensureStateVolume = async (createIfMissing: boolean) => {
  if (await configuredStateVolume()) return
  if (!createIfMissing) {
    throw new RailwayDeploymentError('Railway state volume is not configured')
  }

  const { error } = await tryCatch(
    Promise.resolve(
      $`railway volume add --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --mount-path ${STATE_MOUNT_PATH} --json`.quiet()
    )
  )
  if (error) throw new RailwayDeploymentError('Failed to create the Railway state volume')

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (await configuredStateVolume()) return
    if (attempt < 10) await delay(1_000)
  }

  throw new RailwayDeploymentError('Railway state volume confirmation timed out')
}

const setRuntimeVariable = async ([name, value]: RuntimeVariable) => {
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway variable set ${name} --stdin --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --skip-deploys < ${Buffer.from(value, 'utf8')}`.quiet()
    )
  )
  if (error) throw new RailwayDeploymentError(`Failed to set Railway variable: ${name}`)

  console.log(`Configured ${name}`)
}

const latestDeploymentJson = async () => {
  const { data, error } = await tryCatch(
    Promise.resolve(
      $`railway deployment list --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --limit 1 --json`
        .quiet()
        .text()
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to read Railway deployment status')
  }

  return data
}

const startDeployment = async () => {
  const message = `deploy market-making ${ENVIRONMENT}`
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway up --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --detach --message ${message}`
        .cwd(REPO_ROOT)
        .quiet()
    )
  )
  if (error) throw new RailwayDeploymentError('Failed to start the Railway deployment')
}

const waitForDeployment = async (
  previousDeploymentId: string | undefined,
  maxAttempts = 60,
  intervalMs = 10_000
) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deployment = selectNewRailwayDeployment(
      await latestDeploymentJson(),
      previousDeploymentId
    )
    if (deployment && isTerminalRailwayDeploymentStatus(deployment.status)) return deployment

    console.log(`[${SERVICE}] deployment pending (${attempt}/${maxAttempts})`)
    if (attempt < maxAttempts) await delay(intervalMs)
  }

  throw new RailwayDeploymentError('Railway deployment confirmation timed out')
}

const assertDeploymentSucceeded = (status: string) => {
  if (status !== 'SUCCESS') {
    throw new RailwayDeploymentError(`Railway deployment ended with status: ${status}`)
  }

  console.log(`${SERVICE} deployment succeeded`)
}

const configuration = DEPLOY_ONLY ? [] : runtimeVariables()

await assertCli()
await ensureContext()

if (!DEPLOY_ONLY) await ensureService()

await setRuntimeVariable(['RAILWAY_DOCKERFILE_PATH', DOCKERFILE_PATH])
await setRuntimeVariable(['XDG_STATE_HOME', STATE_MOUNT_PATH])
for (const variable of configuration) await setRuntimeVariable(variable)
await ensureStateVolume(!DEPLOY_ONLY)

const previousDeployment = parseLatestRailwayDeployment(await latestDeploymentJson())
await startDeployment()

const deployment = await waitForDeployment(previousDeployment?.id)
assertDeploymentSucceeded(deployment.status)
