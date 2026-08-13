import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isAddressEqual, isHex, zeroAddress } from 'viem'

import { InvalidConfigurationError } from '../src/config/invalid-configuration.error'
import { InvalidSimulationCallerAddressError } from '../src/config/invalid-simulation-caller-address.error'
import { parseReadonly } from '../src/config/readonly.utils'
import { ResolverPrivateKeyRequiredError } from '../src/config/resolver-private-key-required.error'
import { RailwayAccessTokenRequiredError } from './railway-access-token-required.error'
import { RailwayVariableOperationError } from './railway-variable-operation.error'

type RailwayService = { name: string }
type Env = Record<string, string | undefined>
type RailwayVariableTarget = { environment: string; projectId: string; service: string }
type RailwayAccessToken = {
  header: 'authorization' | 'project-access-token'
  value: string
}
type RailwayVariableTargetIds = { environmentId: string; serviceId: string }
type ProvisioningConfiguration =
  | { readOnly: true; resolverPrivateKey: undefined; simulationCaller: `0x${string}` }
  | { readOnly: false; resolverPrivateKey: string; simulationCaller: undefined }
type ModeVariableOperations = {
  deleteVariable: (name: string) => Promise<void>
  setSecret: (name: string, value: string) => Promise<void>
  setVariable: (value: string) => Promise<void>
}

const railwayVariableTargetArgs = (target: RailwayVariableTarget) => [
  '-s',
  target.service,
  '-e',
  target.environment,
  '-p',
  target.projectId
]

/**
 * Resolves an API credential without exposing it in command arguments or logs.
 * @param env - Deploy environment containing a project or account Railway token.
 * @returns The supported Railway API authentication header and value.
 * @throws `RailwayAccessTokenRequiredError` when no API credential is available.
 */
export const resolveRailwayAccessToken = (env: Env): RailwayAccessToken => {
  const projectToken = env.RAILWAY_TOKEN?.trim()
  if (projectToken) return { header: 'project-access-token', value: projectToken }

  const apiToken = env.RAILWAY_API_TOKEN?.trim()
  if (apiToken) return { header: 'authorization', value: `Bearer ${apiToken}` }
  throw new RailwayAccessTokenRequiredError()
}

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2'
const TARGET_QUERY = `query RailwayVariableTarget($projectId: String!) {
  project(id: $projectId) {
    environments { edges { node { id name } } }
    services { edges { node { id name } } }
  }
}`
const VARIABLES_QUERY = `query Variables(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
  )
}`
const VARIABLE_DELETE_MUTATION = `mutation RailwayVariableDelete(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $name: String!
) {
  variableDelete(input: {
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    name: $name
  })
}`

const recordField = (value: unknown, field: string) =>
  isRecord(value) && isRecord(value[field]) ? value[field] : undefined

const edgesOf = (value: unknown) => {
  const edges = isRecord(value) ? value.edges : undefined
  return Array.isArray(edges) ? edges : []
}

const postRailwayGraphql = async ({
  body,
  error,
  fetcher,
  token
}: {
  body: { query: string; variables: Record<string, unknown> }
  error: RailwayVariableOperationError
  fetcher: typeof fetch
  token: RailwayAccessToken
}) => {
  const result = await tryCatch(
    fetcher(RAILWAY_GRAPHQL_ENDPOINT, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', [token.header]: token.value },
      method: 'POST'
    })
  )
  if (result.error || !result.data.ok) throw error

  const json = await tryCatch(result.data.json())
  if (json.error || !isRecord(json.data) || Array.isArray(json.data.errors)) throw error
  return json.data.data
}

const resolveRailwayVariableTarget = async ({
  error,
  fetcher,
  target,
  token
}: {
  error: RailwayVariableOperationError
  fetcher: typeof fetch
  target: RailwayVariableTarget
  token: RailwayAccessToken
}): Promise<RailwayVariableTargetIds> => {
  const data = await postRailwayGraphql({
    body: { query: TARGET_QUERY, variables: { projectId: target.projectId } },
    error,
    fetcher,
    token
  })
  const project = recordField(data, 'project')
  const environment = edgesOf(recordField(project, 'environments'))
    .map(edge => recordField(edge, 'node'))
    .find(node => node?.name === target.environment)
  const service = edgesOf(recordField(project, 'services'))
    .map(edge => recordField(edge, 'node'))
    .find(node => node?.name === target.service)
  if (typeof environment?.id !== 'string' || typeof service?.id !== 'string') throw error
  return { environmentId: environment.id, serviceId: service.id }
}

/**
 * Idempotently deletes one Railway variable from an explicitly scoped deployment target.
 * @param parameters - Fetch implementation, credential, exact target names, and variable name.
 * @returns `true` when Railway accepts the deletion, or `false` when the variable is already absent.
 * @throws `RailwayVariableOperationError` when target lookup, transport, or deletion fails.
 * @remarks Railway's API exposes key existence through a value-bearing map. This function only
 * checks the requested own key, never logs or returns the map, and skips deletion when absent.
 */
export const deleteRailwayVariable = async ({
  fetcher,
  name,
  target,
  token
}: {
  fetcher: typeof fetch
  name: string
  target: RailwayVariableTarget
  token: RailwayAccessToken
}) => {
  const error = new RailwayVariableOperationError('delete', name)
  const ids = await resolveRailwayVariableTarget({ error, fetcher, target, token })
  const listed = await postRailwayGraphql({
    body: {
      query: VARIABLES_QUERY,
      variables: {
        environmentId: ids.environmentId,
        projectId: target.projectId,
        serviceId: ids.serviceId
      }
    },
    error,
    fetcher,
    token
  })
  const variables = recordField(listed, 'variables')
  if (!variables) throw error
  if (!Object.prototype.hasOwnProperty.call(variables, name)) return false

  const data = await postRailwayGraphql({
    body: {
      query: VARIABLE_DELETE_MUTATION,
      variables: {
        environmentId: ids.environmentId,
        name,
        projectId: target.projectId,
        serviceId: ids.serviceId
      }
    },
    error,
    fetcher,
    token
  })
  if (!isRecord(data) || data.variableDelete !== true) throw error
  return true
}

/**
 * Recognizes Railway CLI's documented missing-variable deletion failure.
 * @param name - Exact variable name passed to `railway variable delete`.
 * @param details - Captured CLI stderr or error message.
 * @returns Whether the failure says that exact variable is absent.
 * @throws Nothing.
 * @remarks Performs no logging or mutation and should only turn this one idempotent case into success.
 */
export const isRailwayVariableMissingError = (name: string, details: string) =>
  details.includes(`Variable '${name}' not found`)

/**
 * Builds arguments for deleting one variable from an exact Railway deployment target.
 * @param name - Name of the variable to delete; no variable value enters command arguments.
 * @param target - Project, environment, and service from which the variable must be deleted.
 * @returns CLI arguments with explicit project, environment, and service context.
 * @throws Nothing; the caller handles Railway CLI failures, including a missing variable in a
 * linked CLI session.
 * @remarks Builds arguments only and performs no I/O or mutation itself.
 */
export const railwayVariableDeleteArgs = (name: string, target: RailwayVariableTarget) => [
  'variable',
  'delete',
  name,
  ...railwayVariableTargetArgs(target)
]

/**
 * Builds arguments for setting one variable on one Railway deployment target.
 * @param value - Public `KEY=VALUE` assignment, or only a variable name when stdin is enabled.
 * @param target - Project, environment, and service that must receive the variable.
 * @param options - Enables secret-safe stdin input without placing the value in command arguments.
 * @returns CLI arguments including supported service, environment, and no-deploy flags.
 * @remarks Secret values remain on stdin when `stdin` is true; only the variable name enters args.
 */
export const railwayVariableSetArgs = (
  value: string,
  target: RailwayVariableTarget,
  { stdin = false }: { stdin?: boolean } = {}
) => [
  'variable',
  'set',
  value,
  ...(stdin ? ['--stdin'] : []),
  ...railwayVariableTargetArgs(target),
  '--skip-deploys'
]

/**
 * Validates mode-specific Railway provisioning values without retaining unused signing material.
 * @param env - Local deploy environment containing mode, caller, and optional signing key.
 * @returns Canonical readonly, simulation-caller, and write-key values for Railway installation.
 * @throws `InvalidConfigurationError` when mode, caller, or key syntax is invalid.
 * @throws `ResolverPrivateKeyRequiredError` when write mode has no signing key.
 * @remarks Readonly mode never reads or returns `RESOLVER_PRIVATE_KEY`.
 */
export const resolveProvisioningConfiguration = (env: Env): ProvisioningConfiguration => {
  const readOnly = parseReadonly(env.READONLY)
  if (readOnly) {
    const caller = env.SIMULATION_CALLER_ADDRESS?.trim()
    if (!caller || !isAddress(caller, { strict: false }) || isAddressEqual(caller, zeroAddress)) {
      throw new InvalidSimulationCallerAddressError()
    }
    return {
      readOnly,
      resolverPrivateKey: undefined,
      simulationCaller: getAddress(caller)
    }
  }

  const resolverPrivateKey = env.RESOLVER_PRIVATE_KEY?.trim()
  if (!resolverPrivateKey) throw new ResolverPrivateKeyRequiredError()
  if (!isHex(resolverPrivateKey, { strict: true }) || resolverPrivateKey.length !== 66) {
    throw new InvalidConfigurationError(
      'RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
  }

  return { readOnly, resolverPrivateKey, simulationCaller: undefined }
}

/**
 * Synchronizes Railway's mutually exclusive mode variables before changing the active mode.
 * @param config - Validated mode-specific provisioning values.
 * @param operations - Secret-safe Railway variable mutation operations.
 * @returns A promise that resolves after the replacement variable and mode are set, then the
 * incompatible variable is removed.
 * @throws The underlying mutation error. A failed replacement or mode update leaves the old
 * mode-specific variable in place.
 * @remarks Secret values are passed only to `setSecret` and are never logged by this helper.
 */
export const synchronizeModeVariables = async (
  config: ReturnType<typeof resolveProvisioningConfiguration>,
  operations: ModeVariableOperations
) => {
  if (config.readOnly) {
    await operations.setVariable(`SIMULATION_CALLER_ADDRESS=${config.simulationCaller}`)
    await operations.setVariable('READONLY=true')
    await operations.deleteVariable('RESOLVER_PRIVATE_KEY')
  } else {
    await operations.setSecret('RESOLVER_PRIVATE_KEY', config.resolverPrivateKey)
    await operations.setVariable('READONLY=false')
    await operations.deleteVariable('SIMULATION_CALLER_ADDRESS')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export function parseServices(raw: string): RailwayService[] {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.services)
      ? data.services
      : []

  return rows
    .filter(isRecord)
    .map(row => ({ name: stringField(row.name) || stringField(row.serviceName) }))
    .filter(service => service.name)
}

export function parseLatestStatus(raw: string) {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.deployments)
      ? data.deployments
      : []
  const latest = rows.filter(isRecord)[0]

  return latest ? stringField(latest.status) || 'UNKNOWN' : 'UNKNOWN'
}
