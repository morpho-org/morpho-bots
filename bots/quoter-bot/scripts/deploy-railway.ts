/**
 * Reproducible Railway provisioning and deployment for the quoter-bot bot.
 *
 * A full run creates the service and uploads runtime variables through stdin. Every run synchronizes
 * the package-owned Dockerfile before deployment, including CI's DEPLOY_ONLY mode for
 * already-provisioned services. Both modes wait for the newly created deployment to reach a terminal
 * state and succeed only on Railway `SUCCESS`.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'execa'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RailwayDeploymentError } from './railway-deployment.error'
import {
  assertFreshRailwayReferenceProvisioning,
  assertFullRailwaySignerProvisioning,
  isNonEmptyJsonArray,
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  parseRailwayVolumes,
  selectNewRailwayDeployment,
  synchronizedOptionalRailwayVariables
} from './railway.utils'

const SERVICE = 'quoter-bot'
const DOCKERFILE_PATH = 'bots/quoter-bot/Dockerfile'
const STATE_MOUNT_PATH = '/state'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DEPLOY_ONLY = /^(1|true)$/i.test(process.env.DEPLOY_ONLY?.trim() || '')
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID?.trim()
if (!PROJECT_ID) {
  throw new RailwayDeploymentError('Missing required environment variable: RAILWAY_PROJECT_ID')
}

const requiredRuntimeVariableNames = [
  'CHAIN_ID',
  'RPC_URL',
  'MAKER_ADDRESS',
  'MIDNIGHT_ADDRESS',
  'LOAN_ASSET_ADDRESS',
  'RATIFIER_ADDRESS',
  'MORPHO_API_BASE_URL',
  'ROUTER_API_BASE_URL',
  'MARKET_IDS',
  'NATIVE_RESERVE_WEI',
  'MAXIMUM_LEND_EXPOSURE_ASSETS',
  'BOOTSTRAP_MARKETS',
  'LADDER_MARKETS'
] as const

type RequiredRuntimeVariableName = (typeof requiredRuntimeVariableNames)[number]
type RuntimeVariable = readonly [name: string, value: string]

const required = (name: RequiredRuntimeVariableName) => {
  const value = process.env[name]?.trim()
  if (!value) throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
  if ((name === 'BOOTSTRAP_MARKETS' || name === 'LADDER_MARKETS') && !isNonEmptyJsonArray(value)) {
    throw new RailwayDeploymentError(`${name} must be a non-empty JSON array`)
  }

  return value
}

const runtimeVariables = (): RuntimeVariable[] => {
  const requiredVariables = requiredRuntimeVariableNames.map(
    name => [name, required(name)] as const
  )
  const optionalVariables = synchronizedOptionalRailwayVariables(process.env)
  const method =
    process.env.KEY_STORAGE_METHOD?.trim() ||
    (process.env.MAKER_PRIVATE_KEY?.trim() ? 'private-key' : '')
  if (!['private-key', 'keystore', 'aws'].includes(method)) {
    throw new RailwayDeploymentError('KEY_STORAGE_METHOD must select exactly one signer')
  }
  assertFullRailwaySignerProvisioning(method as 'private-key' | 'keystore' | 'aws')
  const signerValues: Record<string, string> = {
    KEY_STORAGE_METHOD: method,
    MAKER_PRIVATE_KEY: ' ',
    KEYSTORE_PATH: ' ',
    KEYSTORE_PASSWORD: ' ',
    KEYSTORE_INTERACTIVE: 'false',
    AWS_KMS_KEY_ID: ' ',
    AWS_REGION: ' '
  }
  const signerRequired =
    method === 'private-key'
      ? ['MAKER_PRIVATE_KEY']
      : method === 'keystore'
        ? ['KEYSTORE_PATH', 'KEYSTORE_PASSWORD']
        : ['AWS_KMS_KEY_ID', 'AWS_REGION']
  for (const name of signerRequired) {
    const value = process.env[name]?.trim()
    if (!value) throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
    signerValues[name] = value
  }
  const signerVariables = Object.entries(signerValues) as RuntimeVariable[]

  return [...requiredVariables, ...signerVariables, ...optionalVariables]
}

const assertCli = async () => {
  const { error } = await tryCatch($`railway --version`)
  if (error) throw new RailwayDeploymentError('Railway CLI is unavailable')
}

const ensureContext = async () => {
  if (process.env.RAILWAY_TOKEN) return

  const { error } = await tryCatch(
    $`railway link --project ${PROJECT_ID} --environment ${ENVIRONMENT}`
  )
  if (error) throw new RailwayDeploymentError('Failed to select the Railway project environment')
}

const listServices = async () => {
  const { data, error } = await tryCatch(
    $`railway service list --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`.then(
      result => result.stdout
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to list Railway services')
  }

  return parseRailwayServices(data)
}

const ensureService = async () => {
  const services = await listServices()
  const existingService = services.find(service => service.name === SERVICE)
  if (existingService) return { service: existingService, isFreshService: false }

  assertFreshRailwayReferenceProvisioning(process.env, true)
  const { data, error } = await tryCatch(
    $`railway add --service ${SERVICE} --json`.then(result => result.stdout)
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to create the Railway service')
  }

  const createdService = parseRailwayServices(data).find(service => service.name === SERVICE)
  if (!createdService) {
    throw new RailwayDeploymentError('Railway service creation returned incomplete identity')
  }

  return { service: createdService, isFreshService: true }
}

const listVolumes = async () => {
  const { data, error } = await tryCatch(
    $`railway volume list --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`.then(
      result => result.stdout
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

const ensureStateVolume = async (serviceId: string | undefined) => {
  if (await configuredStateVolume()) return
  if (!serviceId) {
    throw new RailwayDeploymentError('Railway state volume is not configured')
  }

  const { error } = await tryCatch(
    $`railway volume add --service ${serviceId} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --mount-path ${STATE_MOUNT_PATH} --json`
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
    $({
      input: value
    })`railway variable set ${name} --stdin --service ${SERVICE} --environment ${ENVIRONMENT} --skip-deploys`
  )
  if (error) throw new RailwayDeploymentError(`Failed to set Railway variable: ${name}`)

  console.log(`Configured ${name}`)
}

const latestDeploymentJson = async () => {
  const { data, error } = await tryCatch(
    $`railway deployment list --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --limit 1 --json`.then(
      result => result.stdout
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to read Railway deployment status')
  }

  return data
}

const startDeployment = async () => {
  const message = `quoter-bot-${ENVIRONMENT}`
  const { error } = await tryCatch(
    $({
      cwd: REPO_ROOT
    })`railway up --service ${SERVICE} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --detach --message ${message}`
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

await assertCli()
await ensureContext()

if (!DEPLOY_ONLY) {
  const { service } = await ensureService()

  await setRuntimeVariable(['XDG_STATE_HOME', STATE_MOUNT_PATH])
  for (const variable of runtimeVariables()) await setRuntimeVariable(variable)
  await ensureStateVolume(service.id)
}

await setRuntimeVariable(['RAILWAY_DOCKERFILE_PATH', DOCKERFILE_PATH])

const previousDeployment = parseLatestRailwayDeployment(await latestDeploymentJson())
await startDeployment()

const deployment = await waitForDeployment(previousDeployment?.id)
assertDeploymentSucceeded(deployment.status)
