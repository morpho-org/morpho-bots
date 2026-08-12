import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isHex } from 'viem'

import { InvalidConfigurationError } from '../src/config/invalid-configuration.error'
import { parseReadonly } from '../src/config/readonly.utils'
import { ResolverPrivateKeyRequiredError } from '../src/config/resolver-private-key-required.error'

type RailwayService = { name: string }
type Env = Record<string, string | undefined>

/**
 * Validates mode-specific Railway provisioning values without retaining unused signing material.
 * @param env - Local deploy environment containing mode, caller, and optional signing key.
 * @returns Canonical readonly, simulation-caller, and write-key values for Railway installation.
 * @throws `InvalidConfigurationError` when mode, caller, or key syntax is invalid.
 * @throws `ResolverPrivateKeyRequiredError` when write mode has no signing key.
 * @remarks Readonly mode never reads or returns `RESOLVER_PRIVATE_KEY`.
 */
export const resolveProvisioningConfiguration = (env: Env) => {
  const readOnly = parseReadonly(env.READONLY)
  if (readOnly) {
    const caller = env.SIMULATION_CALLER_ADDRESS?.trim()
    if (!caller || !isAddress(caller, { strict: false })) {
      throw new InvalidConfigurationError(
        'Readonly mode requires a valid SIMULATION_CALLER_ADDRESS'
      )
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
