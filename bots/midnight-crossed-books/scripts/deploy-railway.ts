/**
 * Reproducible Railway deployment for the Midnight crossed-books bot.
 *
 * A full run provisions the target service and its runtime variables. CI sets DEPLOY_ONLY=true to
 * re-ship the already-provisioned service without copying any bot secrets into GitHub.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'execa'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deleteRailwayVariable,
  isRailwayVariableMissingError,
  parseLatestStatus,
  parseServices,
  railwayVariableDeleteArgs,
  railwayVariableSetArgs,
  resolveRailwayAccessToken,
  resolveProvisioningConfiguration,
  synchronizeModeVariables
} from './railway'
import { RailwayVariableOperationError } from './railway-variable-operation.error'

const PROJECT_ID = required(process.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const SERVICE = ENVIRONMENT === 'production' ? 'bot' : `${ENVIRONMENT}-bot`
const VARIABLE_TARGET = { environment: ENVIRONMENT, projectId: PROJECT_ID, service: SERVICE }
const DOCKERFILE_PATH = 'bots/midnight-crossed-books/Dockerfile'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEPLOY_ONLY = /^(1|true)$/i.test(process.env.DEPLOY_ONLY?.trim() || '')
const TERMINAL_STATUSES = new Set([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'NEEDS_APPROVAL',
  'SLEEPING',
  'SKIPPED',
  'REMOVED',
  'REMOVING'
])

type Env = Record<string, string | undefined>

function required(env: Env, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorDetails(error: unknown) {
  if (isRecord(error) && 'stderr' in error) {
    const stderr = error.stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
    if (stderr instanceof Uint8Array) {
      const text = Buffer.from(stderr).toString('utf8').trim()
      if (text) return text
    }
  }
  return error instanceof Error ? error.message : String(error)
}

async function assertCli() {
  const { error } = await tryCatch($`railway --version`)
  if (error) {
    throw new Error('Railway CLI not found. Install it: https://docs.railway.com/guides/cli')
  }
}

async function ensureContext() {
  if (process.env.RAILWAY_TOKEN) {
    console.log('Using RAILWAY_TOKEN for project context.')
    return
  }

  const { error } = await tryCatch($`railway link -p ${PROJECT_ID} -e ${ENVIRONMENT}`)
  if (error) {
    throw new Error(
      `Failed to link ${PROJECT_ID} (${ENVIRONMENT}). Set RAILWAY_TOKEN or run \`railway login\`.`
    )
  }
  console.log(`Linked project ${PROJECT_ID} (${ENVIRONMENT}).`)
}

async function listServices() {
  const { data, error } = await tryCatch($`railway service list --json`.then(r => r.stdout))
  return error || typeof data !== 'string' ? [] : parseServices(data)
}

async function ensureService() {
  if ((await listServices()).some(service => service.name === SERVICE)) {
    console.log(`Service ${SERVICE} already exists.`)
    return false
  }

  const { error } = await tryCatch($`railway add --service ${SERVICE} --json`)
  if (error) throw new Error(`Failed to create service ${SERVICE}: ${errorDetails(error)}`)
  console.log(`Created service ${SERVICE}.`)
  return true
}

async function setVariable(value: string) {
  const key = value.split('=')[0]
  const { error } = await tryCatch($('railway', railwayVariableSetArgs(value, VARIABLE_TARGET)))
  if (error) throw new RailwayVariableOperationError('set', key)
  console.log(`Set ${key} on ${SERVICE}.`)
}

async function setSecret(name: string, value: string) {
  const { error } = await tryCatch(
    $({ input: value })('railway', railwayVariableSetArgs(name, VARIABLE_TARGET, { stdin: true }))
  )
  if (error) throw new RailwayVariableOperationError('set', name)
  console.log(`Set ${name} on ${SERVICE} (secret).`)
}

const deleteVariable = async (name: string) => {
  if (!process.env.RAILWAY_TOKEN?.trim() && !process.env.RAILWAY_API_TOKEN?.trim()) {
    const { error } = await tryCatch($('railway', railwayVariableDeleteArgs(name, VARIABLE_TARGET)))
    if (error && !isRailwayVariableMissingError(name, errorDetails(error))) {
      throw new RailwayVariableOperationError('delete', name)
    }
    if (error) {
      console.log(`${name} is already absent on ${SERVICE}.`)
      return
    }
    console.log(`Deleted ${name} on ${SERVICE} (stale).`)
    return
  }

  const deleted = await deleteRailwayVariable({
    fetcher: fetch,
    name,
    target: VARIABLE_TARGET,
    token: resolveRailwayAccessToken(process.env)
  })
  console.log(
    deleted ? `Deleted ${name} on ${SERVICE} (stale).` : `${name} is already absent on ${SERVICE}.`
  )
}

const skipVariableDeletion = async (name: string) => {
  console.log(`${name} is already absent on newly created service ${SERVICE}.`)
}

async function deployService() {
  const message = `deploy midnight crossed-books ${ENVIRONMENT}`
  const { error } = await tryCatch(
    $({
      cwd: REPO_ROOT
    })`railway up -s ${SERVICE} -p ${PROJECT_ID} -e ${ENVIRONMENT} -d -m ${message}`
  )
  if (error) throw new Error(`Failed to start deploy for ${SERVICE}: ${errorDetails(error)}`)
}

async function latestStatus() {
  const args = [
    'railway',
    'deployment',
    'list',
    '-s',
    SERVICE,
    '-e',
    ENVIRONMENT,
    '-p',
    PROJECT_ID,
    '--limit',
    '1',
    '--json'
  ]
  const { data, error } = await tryCatch($(args[0] ?? 'railway', args.slice(1)).then(r => r.stdout))
  return error || typeof data !== 'string' ? 'UNKNOWN' : parseLatestStatus(data)
}

async function waitForDeploy(maxAttempts = 60, intervalMs = 10_000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await latestStatus()
    if (TERMINAL_STATUSES.has(status)) return status
    console.log(`[${SERVICE}] ${status} (${attempt}/${maxAttempts})…`)
    await delay(intervalMs)
  }
  return 'TIMEOUT'
}

function reportStatus(status: string) {
  console.log('')
  console.log('=== Deployment status ===')
  console.log(`  ${SERVICE}: ${status}`)
  process.exitCode = status === 'SUCCESS' ? 0 : 1
}

await assertCli()

if (DEPLOY_ONLY) {
  await ensureContext()
  await deployService()
  reportStatus(await waitForDeploy())
} else {
  const rpcUrl = required(process.env, 'RPC_URL')
  const config = resolveProvisioningConfiguration(process.env)

  await ensureContext()
  const serviceCreated = await ensureService()
  await setVariable('CHAIN_ID=8453')
  await synchronizeModeVariables(config, {
    deleteVariable: serviceCreated ? skipVariableDeletion : deleteVariable,
    setSecret,
    setVariable
  })
  await setVariable(`RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
  await setSecret('RPC_URL', rpcUrl)
  await deployService()
  reportStatus(await waitForDeploy())
}
