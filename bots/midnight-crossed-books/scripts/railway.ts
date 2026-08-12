import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isAddressEqual, isHex, zeroAddress } from 'viem'

import { InvalidConfigurationError } from '../src/config/invalid-configuration.error'
import { InvalidSimulationCallerAddressError } from '../src/config/invalid-simulation-caller-address.error'
import { parseReadonly } from '../src/config/readonly.utils'
import { ResolverPrivateKeyRequiredError } from '../src/config/resolver-private-key-required.error'
import { InvalidRailwayVariableListError } from './invalid-railway-variable-list.error'

type RailwayService = { name: string }
type Env = Record<string, string | undefined>
type ProvisioningConfiguration =
  | { readOnly: true; resolverPrivateKey: undefined; simulationCaller: `0x${string}` }
  | { readOnly: false; resolverPrivateKey: string; simulationCaller: undefined }
type ModeVariableOperations = {
  deleteVariable: (name: string) => Promise<void>
  setSecret: (name: string, value: string) => Promise<void>
  setVariable: (value: string) => Promise<void>
}

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
 * @param existingKeys - Variable names currently installed on the target service.
 * @param operations - Secret-safe Railway variable mutation operations.
 * @returns A promise that resolves after incompatible variables are removed and the mode is set.
 * @throws The underlying mutation error; mode is not changed when incompatible-variable deletion
 * fails.
 * @remarks Secret values are passed only to `setSecret` and are never logged by this helper.
 */
export const synchronizeModeVariables = async (
  config: ReturnType<typeof resolveProvisioningConfiguration>,
  existingKeys: ReadonlySet<string>,
  operations: ModeVariableOperations
) => {
  if (config.readOnly) {
    if (existingKeys.has('RESOLVER_PRIVATE_KEY')) {
      await operations.deleteVariable('RESOLVER_PRIVATE_KEY')
    }
    await operations.setVariable(`SIMULATION_CALLER_ADDRESS=${config.simulationCaller}`)
  } else {
    if (existingKeys.has('SIMULATION_CALLER_ADDRESS')) {
      await operations.deleteVariable('SIMULATION_CALLER_ADDRESS')
    }
    await operations.setSecret('RESOLVER_PRIVATE_KEY', config.resolverPrivateKey)
  }
  await operations.setVariable(`READONLY=${config.readOnly}`)
}

/**
 * Reads only variable names from Railway's JSON response.
 * @param raw - Raw JSON emitted by `railway variable list --json`.
 * @returns Installed variable names without retaining their values.
 * @throws `InvalidRailwayVariableListError` when Railway returns malformed or unexpected JSON.
 */
export const parseVariableKeys = (raw: string) => {
  const { data, error } = tryCatch(() => JSON.parse(raw) as unknown)
  if (error || !isRecord(data) || Array.isArray(data)) {
    throw new InvalidRailwayVariableListError()
  }
  return new Set(Object.keys(data))
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
