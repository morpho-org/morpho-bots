import { tryCatch } from '@repo/utils'

import { RailwayDeploymentError } from './railway-deployment.error'

type RailwayDeployment = {
  id: string
  status: string
}

type RailwayService = {
  id: string
  name: string
}

type RailwayVolume = {
  id: string
  isPendingDeletion: boolean
  mountPath: string
  serviceName: string
}

const optionalRuntimeVariableDefaults = [
  ['REFERENCE_RPC_URL', ' '],
  ['REFERENCE_MARKET_ID', ' '],
  ['V0_OFFER_GROUP_IDS', ' '],
  ['REQUEST_TIMEOUT_MS', '10000'],
  ['TRANSACTION_RECEIPT_TIMEOUT_MS', '180000'],
  ['BETTERSTACK_SOURCE_TOKEN', ' '],
  ['BETTERSTACK_INGESTING_HOST', ' '],
  ['BETTERSTACK_HEARTBEAT_URL', ' ']
] as const

const referenceVariableNames = new Set(['REFERENCE_RPC_URL', 'REFERENCE_MARKET_ID'])

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

/**
 * Rejects full Railway provisioning for signer modes whose credentials or files cannot be seeded.
 * @param method - Validated signer method selected by the invoking environment.
 * @throws `RailwayDeploymentError` for keystore or AWS KMS full provisioning.
 * @remarks Existing services may use those modes only after out-of-band provisioning followed by
 * `DEPLOY_ONLY=true`; this guard performs no Railway or filesystem side effects.
 */
export const assertFullRailwaySignerProvisioning = (method: 'private-key' | 'keystore' | 'aws') => {
  if (method === 'keystore') {
    throw new RailwayDeploymentError(
      'Keystore Railway deployment requires a pre-provisioned file; use DEPLOY_ONLY=true'
    )
  }
  if (method === 'aws') {
    throw new RailwayDeploymentError(
      'AWS KMS Railway deployment requires pre-provisioned credentials; use DEPLOY_ONLY=true'
    )
  }
}

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

const everyConfiguredWorkflowUsesHardcodedRate = (
  environment: Readonly<Record<string, string | undefined>>
) =>
  ['BOOTSTRAP_MARKETS', 'LADDER_MARKETS'].every(name => {
    const { data } = tryCatch(() => JSON.parse(environment[name] ?? '') as unknown)
    return (
      Array.isArray(data) &&
      data.length > 0 &&
      data.every(
        item =>
          isRecord(item) && isRecord(item.targetRate) && item.targetRate.strategy === 'hardcoded'
      )
    )
  })

/**
 * Rejects fresh Railway services that would start a variable-rate workflow without Blue references.
 * @param environment - Invoking environment containing strategy and optional reference variables.
 * @param isFreshService - Whether this provisioning run created the Railway service.
 * @throws `RailwayDeploymentError` when a fresh variable-rate service lacks either Blue reference.
 * @remarks Existing services preserve omitted Railway reference variables; hardcoded-only services do
 * not require Blue configuration.
 */
export const assertFreshRailwayReferenceProvisioning = (
  environment: Readonly<Record<string, string | undefined>>,
  isFreshService: boolean
) => {
  if (!isFreshService || everyConfiguredWorkflowUsesHardcodedRate(environment)) return

  for (const name of ['REFERENCE_RPC_URL', 'REFERENCE_MARKET_ID'] as const) {
    if (!environment[name]?.trim()) {
      throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
    }
  }
}

/**
 * Produces optional Railway configuration for a full operator deployment.
 * @param environment - Invoking environment whose non-blank values override safe defaults.
 * @returns Optional variables with timeouts reset to runtime defaults. Missing reference variables
 * are cleared only when every configured workflow uses a hardcoded target rate; otherwise they are
 * omitted so a full deployment preserves any existing Railway Blue configuration.
 * @remarks Railway CLI 5.30.4 rejects empty stdin values. The bot trims whitespace sentinels to an
 * unset value, allowing full runs to clear stale inactive configuration without triggering
 * intermediate deployments.
 */
export const synchronizedOptionalRailwayVariables = (
  environment: Readonly<Record<string, string | undefined>>
): OptionalRuntimeVariable[] =>
  optionalRuntimeVariableDefaults.flatMap(([name, defaultValue]) => {
    const configuredValue = environment[name]?.trim()
    if (
      referenceVariableNames.has(name) &&
      !configuredValue &&
      !everyConfiguredWorkflowUsesHardcodedRate(environment)
    ) {
      return []
    }

    return [[name, configuredValue || defaultValue]]
  })

/**
 * Parses Railway service JSON without exposing unknown response fields.
 * @param raw - Complete JSON emitted by `railway service list --json` or `railway add --json`.
 * @returns Identified, named services in response order; malformed or incomplete rows are omitted.
 */
export const parseRailwayServices = (raw: string): RailwayService[] => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = isRecord(data) && stringField(data.id) ? [data] : rowsFrom(data, 'services')

  return rows
    .filter(isRecord)
    .map(row => ({
      id: stringField(row.id),
      name: stringField(row.name) || stringField(row.serviceName)
    }))
    .filter(service => service.id.length > 0 && service.name.length > 0)
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
