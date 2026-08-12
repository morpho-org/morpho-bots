import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

import {
  parseLatestStatus,
  parseServices,
  parseVariableKeys,
  resolveProvisioningConfiguration,
  synchronizeModeVariables
} from '../../scripts/railway'
import { InvalidConfigurationError } from '../../src/config/invalid-configuration.error'
import { InvalidSimulationCallerAddressError } from '../../src/config/invalid-simulation-caller-address.error'
import { ResolverPrivateKeyRequiredError } from '../../src/config/resolver-private-key-required.error'

const KEY = `0x${'11'.repeat(32)}`
const CALLER: `0x${string}` = `0x${'22'.repeat(20)}`

const operations = () => ({
  deleteVariable: vi.fn().mockResolvedValue(undefined),
  setSecret: vi.fn().mockResolvedValue(undefined),
  setVariable: vi.fn().mockResolvedValue(undefined)
})

describe('Railway provisioning configuration', () => {
  test('supports keyless readonly provisioning with an execution-equivalent caller', () => {
    expect(
      resolveProvisioningConfiguration({
        READONLY: 'TRUE',
        SIMULATION_CALLER_ADDRESS: CALLER,
        RESOLVER_PRIVATE_KEY: 'ignored-in-readonly-mode'
      })
    ).toEqual({
      readOnly: true,
      resolverPrivateKey: undefined,
      simulationCaller: CALLER
    })
  })

  test('preserves write-mode key requirements and provisioning', () => {
    expect(resolveProvisioningConfiguration({ RESOLVER_PRIVATE_KEY: KEY })).toEqual({
      readOnly: false,
      resolverPrivateKey: KEY,
      simulationCaller: undefined
    })
    expect(() => resolveProvisioningConfiguration({})).toThrow(ResolverPrivateKeyRequiredError)
  })

  test.each([
    [{ READONLY: 'yes', RESOLVER_PRIVATE_KEY: KEY }, 'READONLY'],
    [{ READONLY: 'true' }, 'SIMULATION_CALLER_ADDRESS'],
    [{ READONLY: 'true', SIMULATION_CALLER_ADDRESS: 'invalid' }, 'SIMULATION_CALLER_ADDRESS'],
    [{ RESOLVER_PRIVATE_KEY: '0x12' }, 'RESOLVER_PRIVATE_KEY']
  ])('rejects invalid provisioning configuration %#', (environment, message) => {
    expect(() => resolveProvisioningConfiguration(environment)).toThrow(InvalidConfigurationError)
    expect(() => resolveProvisioningConfiguration(environment)).toThrow(message)
  })

  test('rejects the zero simulation caller address with a named error', () => {
    expect(() =>
      resolveProvisioningConfiguration({
        READONLY: 'true',
        SIMULATION_CALLER_ADDRESS: '0x0000000000000000000000000000000000000000'
      })
    ).toThrow(InvalidSimulationCallerAddressError)
  })

  test('removes a stale private key before switching to readonly mode', async () => {
    const railway = operations()

    await synchronizeModeVariables(
      { readOnly: true, resolverPrivateKey: undefined, simulationCaller: CALLER },
      new Set(['RESOLVER_PRIVATE_KEY']),
      railway
    )

    expect(railway.deleteVariable).toHaveBeenCalledExactlyOnceWith('RESOLVER_PRIVATE_KEY')
    expect(railway.setSecret).not.toHaveBeenCalled()
    expect(railway.setVariable.mock.calls).toEqual([
      [`SIMULATION_CALLER_ADDRESS=${CALLER}`],
      ['READONLY=true']
    ])
  })

  test('removes a stale simulation caller before switching to write mode', async () => {
    const railway = operations()

    await synchronizeModeVariables(
      { readOnly: false, resolverPrivateKey: KEY, simulationCaller: undefined },
      new Set(['SIMULATION_CALLER_ADDRESS']),
      railway
    )

    expect(railway.deleteVariable).toHaveBeenCalledExactlyOnceWith('SIMULATION_CALLER_ADDRESS')
    expect(railway.setSecret).toHaveBeenCalledExactlyOnceWith('RESOLVER_PRIVATE_KEY', KEY)
    expect(railway.setVariable).toHaveBeenCalledExactlyOnceWith('READONLY=false')
  })

  test('does not change readonly mode when stale-key deletion fails', async () => {
    const railway = operations()
    railway.deleteVariable.mockRejectedValue(new Error('delete failed'))
    const config = resolveProvisioningConfiguration({
      READONLY: 'true',
      SIMULATION_CALLER_ADDRESS: CALLER
    })

    await expect(
      synchronizeModeVariables(config, new Set(['RESOLVER_PRIVATE_KEY']), railway)
    ).rejects.toThrow('delete failed')
    expect(railway.setSecret).not.toHaveBeenCalled()
    expect(railway.setVariable).not.toHaveBeenCalled()
  })

  test('does not change write mode when stale-caller deletion fails', async () => {
    const railway = operations()
    railway.deleteVariable.mockRejectedValue(new Error('delete failed'))
    const config = resolveProvisioningConfiguration({ RESOLVER_PRIVATE_KEY: KEY })

    await expect(
      synchronizeModeVariables(config, new Set(['SIMULATION_CALLER_ADDRESS']), railway)
    ).rejects.toThrow('delete failed')
    expect(railway.setSecret).not.toHaveBeenCalled()
    expect(railway.setVariable).not.toHaveBeenCalled()
  })

  test('provisions a new readonly service without attempting an absent-key deletion', async () => {
    const railway = operations()

    await synchronizeModeVariables(
      { readOnly: true, resolverPrivateKey: undefined, simulationCaller: CALLER },
      new Set(),
      railway
    )

    expect(railway.deleteVariable).not.toHaveBeenCalled()
    expect(railway.setVariable).toHaveBeenCalledTimes(2)
  })

  test('provisions a new write service without attempting an absent-caller deletion', async () => {
    const railway = operations()

    await synchronizeModeVariables(
      { readOnly: false, resolverPrivateKey: KEY, simulationCaller: undefined },
      new Set(),
      railway
    )

    expect(railway.deleteVariable).not.toHaveBeenCalled()
    expect(railway.setSecret).toHaveBeenCalledExactlyOnceWith('RESOLVER_PRIVATE_KEY', KEY)
    expect(railway.setVariable).toHaveBeenCalledExactlyOnceWith('READONLY=false')
  })

  test('wires fail-closed mode synchronization into Railway provisioning', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(deploy).toMatch(/resolveProvisioningConfiguration\(\s*process\.env\s*\)/)
    expect(deploy).toContain('await listVariableKeys()')
    expect(deploy).toContain('await synchronizeModeVariables(')
    expect(deploy).toContain('deleteVariable')
  })
})

describe('Railway CLI output parsing', () => {
  test('extracts variable names without exposing values', () => {
    expect(parseVariableKeys('{"RESOLVER_PRIVATE_KEY":"secret","READONLY":"true"}')).toEqual(
      new Set(['RESOLVER_PRIVATE_KEY', 'READONLY'])
    )
  })

  test.each(['not-json', '[]', 'null'])('rejects an unsafe variable list response %#', raw => {
    expect(() => parseVariableKeys(raw)).toThrow('Railway returned an invalid variable list')
  })

  test('parses service arrays and ignores nameless entries', () => {
    const raw = JSON.stringify([{ name: 'bot' }, { id: 'missing-name' }])

    expect(parseServices(raw)).toEqual([{ name: 'bot' }])
  })

  test('parses wrapped services with the legacy serviceName field', () => {
    const raw = JSON.stringify({ services: [{ serviceName: 'staging-bot' }] })

    expect(parseServices(raw)).toEqual([{ name: 'staging-bot' }])
  })

  test('returns no services for invalid JSON', () => {
    expect(parseServices('not-json')).toEqual([])
  })

  test('reads the newest deployment status', () => {
    const raw = JSON.stringify({ deployments: [{ status: 'SUCCESS' }, { status: 'FAILED' }] })

    expect(parseLatestStatus(raw)).toBe('SUCCESS')
  })

  test('returns UNKNOWN when no deployment status is available', () => {
    expect(parseLatestStatus('{"deployments":[]}')).toBe('UNKNOWN')
    expect(parseLatestStatus('not-json')).toBe('UNKNOWN')
  })
})
