import { tryCatch } from '@repo/utils'

type RailwayDeployment = {
  id: string
  status: string
}

type RailwayService = {
  name: string
}

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

const rowsFrom = (value: unknown, key: 'deployments' | 'services') => {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []

  const rows = value[key]
  return Array.isArray(rows) ? rows : []
}

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
