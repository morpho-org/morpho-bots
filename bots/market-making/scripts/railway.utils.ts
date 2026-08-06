import { tryCatch } from '@repo/utils'

type RailwayDeployment = {
  id: string
  status: string
}

type RailwayService = {
  name: string
}

type RailwayVolume = {
  id: string
  isPendingDeletion: boolean
  mountPath: string
  serviceName: string
}

const optionalRuntimeVariableDefaults = [
  ['V0_OFFER_GROUP_IDS', ' '],
  ['REQUEST_TIMEOUT_MS', '10000'],
  ['TRANSACTION_RECEIPT_TIMEOUT_MS', '180000'],
  ['BETTERSTACK_SOURCE_TOKEN', ' '],
  ['BETTERSTACK_INGESTING_HOST', ' '],
  ['BETTERSTACK_HEARTBEAT_URL', ' ']
] as const

type OptionalRuntimeVariableName = (typeof optionalRuntimeVariableDefaults)[number][0]
type OptionalRuntimeVariable = readonly [name: OptionalRuntimeVariableName, value: string]

const terminalStatuses = new Set([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'NEEDS_APPROVAL',
  'SLEEPING',
  'SKIPPED',
  'REMOVED',
  'REMOVING'
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringField = (value: unknown) => (typeof value === 'string' ? value : '')

const rowsFrom = (value: unknown, key: 'deployments' | 'services' | 'volumes') => {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []

  const rows = value[key]
  return Array.isArray(rows) ? rows : []
}

/**
 * Checks whether a deployment strategy value is a populated JSON array.
 * @param raw - Candidate environment value before runtime configuration parsing.
 * @returns `true` only when the value is valid JSON whose root array contains at least one entry.
 * @remarks Entry-level validation remains the responsibility of the runtime configuration loader.
 */
export const isNonEmptyJsonArray = (raw: string) => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)

  return Array.isArray(data) && data.length > 0
}

/**
 * Produces the complete optional Railway configuration for a full operator deployment.
 * @param environment - Invoking environment whose non-blank values override safe defaults.
 * @returns Every optional variable exactly once, with timeouts reset to runtime defaults and
 * trimmed string options represented by a whitespace sentinel when absent.
 * @remarks Railway CLI 5.30.4 rejects empty stdin values. The bot trims the sentinel to an unset
 * value, allowing full runs to clear stale optional configuration without triggering intermediate
 * deployments.
 */
export const synchronizedOptionalRailwayVariables = (
  environment: Readonly<Record<string, string | undefined>>
): OptionalRuntimeVariable[] =>
  optionalRuntimeVariableDefaults.map(([name, defaultValue]) => [
    name,
    environment[name]?.trim() || defaultValue
  ])

/**
 * Parses Railway service-list JSON without exposing unknown response fields.
 * @param raw - Complete JSON emitted by `railway service list --json`.
 * @returns Named services in response order; malformed and nameless rows are omitted.
 */
export const parseRailwayServices = (raw: string): RailwayService[] => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = rowsFrom(data, 'services')

  return rows
    .filter(isRecord)
    .map(row => ({ name: stringField(row.name) || stringField(row.serviceName) }))
    .filter(service => service.name.length > 0)
}

/**
 * Parses attached Railway volume identity and mount metadata from CLI JSON.
 * @param raw - Complete JSON emitted by `railway volume list --json`.
 * @returns Complete attached volumes in response order; malformed or unattached rows are omitted.
 */
export const parseRailwayVolumes = (raw: string): RailwayVolume[] => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = rowsFrom(data, 'volumes')

  return rows.filter(isRecord).flatMap(row => {
    const id = stringField(row.id)
    const mountPath = stringField(row.mountPath)
    const serviceName = stringField(row.serviceName)
    if (!id || !mountPath || !serviceName || typeof row.isPendingDeletion !== 'boolean') return []

    return [
      {
        id,
        isPendingDeletion: row.isPendingDeletion,
        mountPath,
        serviceName
      }
    ]
  })
}

/**
 * Parses only the newest Railway deployment identity and status from CLI JSON.
 * @param raw - Complete JSON emitted by `railway deployment list --json`.
 * @returns The newest complete deployment, or `undefined` for malformed or empty output.
 */
export const parseLatestRailwayDeployment = (raw: string): RailwayDeployment | undefined => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const latest = rowsFrom(data, 'deployments').filter(isRecord)[0]
  if (!latest) return undefined

  const id = stringField(latest.id)
  const status = stringField(latest.status)
  return id && status ? { id, status } : undefined
}

/**
 * Selects a deployment created after the caller's pre-deploy snapshot.
 * @param raw - Complete JSON emitted by `railway deployment list --json`.
 * @param previousDeploymentId - Newest deployment ID observed before starting the upload.
 * @returns The new deployment, or `undefined` while Railway still reports the previous deployment.
 */
export const selectNewRailwayDeployment = (
  raw: string,
  previousDeploymentId: string | undefined
) => {
  const latest = parseLatestRailwayDeployment(raw)
  if (!latest || latest.id === previousDeploymentId) return undefined

  return latest
}

/**
 * Identifies lifecycle states after which Railway will make no further deployment progress.
 * @param status - Deployment status returned by Railway.
 * @returns `true` only for Railway terminal statuses handled by the deploy script.
 */
export const isTerminalRailwayDeploymentStatus = (status: string) => terminalStatuses.has(status)
