import { tryCatch } from '@repo/utils'

type RailwayService = { name: string }
type Env = Record<string, string | undefined>

function required(env: Env, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export function resolveProvisioningConfiguration(env: Env) {
  const value = env.READONLY?.trim().toLowerCase()
  if (value && !['true', 'false', '1', '0'].includes(value)) {
    throw new Error('READONLY must be one of: true, false, 1, 0')
  }

  const readOnly = value === 'true' || value === '1'
  const resolverPrivateKey = readOnly ? undefined : required(env, 'RESOLVER_PRIVATE_KEY')
  if (resolverPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(resolverPrivateKey)) {
    throw new Error('RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }

  return { readOnly, resolverPrivateKey }
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
