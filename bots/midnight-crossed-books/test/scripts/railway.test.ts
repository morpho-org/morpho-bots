import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

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
} from '../../scripts/railway'
import { InvalidConfigurationError } from '../../src/config/invalid-configuration.error'
import { InvalidSimulationCallerAddressError } from '../../src/config/invalid-simulation-caller-address.error'
import { ResolverPrivateKeyRequiredError } from '../../src/config/resolver-private-key-required.error'

const KEY = `0x${'11'.repeat(32)}`
const CALLER: `0x${string}` = `0x${'22'.repeat(20)}`
const TARGET = { environment: 'production', projectId: 'project-id', service: 'bot' }
const TOKEN = { header: 'project-access-token' as const, value: 'railway-token' }

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const targetResponse = {
  data: {
    project: {
      environments: { edges: [{ node: { id: 'environment-id', name: 'production' } }] },
      services: { edges: [{ node: { id: 'service-id', name: 'bot' } }] }
    }
  }
}

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

  test('preserves write-mode key requirements and ignores the readonly caller', () => {
    expect(
      resolveProvisioningConfiguration({
        RESOLVER_PRIVATE_KEY: KEY,
        SIMULATION_CALLER_ADDRESS: 'invalid-and-ignored-in-write-mode'
      })
    ).toEqual({
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

  test('switches to readonly mode before deleting the stale private key', async () => {
    const events: string[] = []
    const railway = {
      deleteVariable: vi.fn(async name => {
        events.push(`delete:${name}`)
      }),
      setSecret: vi.fn(async (name, _value) => {
        events.push(`secret:${name}`)
      }),
      setVariable: vi.fn(async value => {
        events.push(`set:${value}`)
      })
    }

    await synchronizeModeVariables(
      { readOnly: true, resolverPrivateKey: undefined, simulationCaller: CALLER },
      railway
    )

    expect(events).toEqual([
      `set:SIMULATION_CALLER_ADDRESS=${CALLER}`,
      'set:READONLY=true',
      'delete:RESOLVER_PRIVATE_KEY'
    ])
    expect(railway.setSecret).not.toHaveBeenCalled()
  })

  test('switches to write mode before deleting the stale caller', async () => {
    const events: string[] = []
    const railway = {
      deleteVariable: vi.fn(async name => {
        events.push(`delete:${name}`)
      }),
      setSecret: vi.fn(async (name, _value) => {
        events.push(`secret:${name}`)
      }),
      setVariable: vi.fn(async value => {
        events.push(`set:${value}`)
      })
    }

    await synchronizeModeVariables(
      { readOnly: false, resolverPrivateKey: KEY, simulationCaller: undefined },
      railway
    )

    expect(events).toEqual([
      'secret:RESOLVER_PRIVATE_KEY',
      'set:READONLY=false',
      'delete:SIMULATION_CALLER_ADDRESS'
    ])
  })

  test('does not delete the private key when switching to readonly mode fails', async () => {
    const railway = operations()
    railway.setVariable.mockRejectedValueOnce(new Error('set failed'))
    const config = resolveProvisioningConfiguration({
      READONLY: 'true',
      SIMULATION_CALLER_ADDRESS: CALLER
    })

    await expect(synchronizeModeVariables(config, railway)).rejects.toThrow('set failed')
    expect(railway.deleteVariable).not.toHaveBeenCalled()
  })

  test('does not delete the caller when switching to write mode fails', async () => {
    const railway = operations()
    railway.setVariable.mockRejectedValueOnce(new Error('set failed'))
    const config = resolveProvisioningConfiguration({ RESOLVER_PRIVATE_KEY: KEY })

    await expect(synchronizeModeVariables(config, railway)).rejects.toThrow('set failed')
    expect(railway.deleteVariable).not.toHaveBeenCalled()
  })

  test('wires fail-closed mode synchronization into Railway provisioning', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(deploy).toMatch(/resolveProvisioningConfiguration\(\s*process\.env\s*\)/)
    expect(deploy).toContain('await synchronizeModeVariables(')
    expect(deploy).toContain('deleteVariable')
    expect(deploy).not.toContain('variable list')
    expect(deploy).not.toContain('railwayVariableListArgs')
    expect(deploy).toContain("throw new RailwayVariableOperationError('set', key)")
    expect(deploy).toContain("throw new RailwayVariableOperationError('set', name)")
    expect(deploy).not.toMatch(/Failed to set.*errorDetails/)
  })

  test('preserves fresh-service and CLI-login provisioning without an API token', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(deploy).toContain('const serviceCreated = await ensureService()')
    expect(deploy).toContain(
      'deleteVariable: serviceCreated ? skipVariableDeletion : deleteVariable'
    )
    expect(deploy).toContain("$('railway', railwayVariableDeleteArgs(name, VARIABLE_TARGET))")
  })

  test('includes explicit project context when setting variables', () => {
    expect(railwayVariableSetArgs('READONLY=true', TARGET)).toEqual([
      'variable',
      'set',
      'READONLY=true',
      '-s',
      'bot',
      '-e',
      'production',
      '-p',
      'project-id',
      '--skip-deploys'
    ])
    expect(railwayVariableSetArgs('RPC_URL', TARGET, { stdin: true })).toEqual([
      'variable',
      'set',
      'RPC_URL',
      '--stdin',
      '-s',
      'bot',
      '-e',
      'production',
      '-p',
      'project-id',
      '--skip-deploys'
    ])
  })

  test('includes explicit project context in CLI deletion', () => {
    expect(railwayVariableDeleteArgs('RESOLVER_PRIVATE_KEY', TARGET)).toEqual([
      'variable',
      'delete',
      'RESOLVER_PRIVATE_KEY',
      '-s',
      'bot',
      '-e',
      'production',
      '-p',
      'project-id'
    ])
  })

  test('recognizes only the Railway CLI missing-variable failure as idempotent', () => {
    expect(
      isRailwayVariableMissingError(
        'RESOLVER_PRIVATE_KEY',
        "Error: Variable 'RESOLVER_PRIVATE_KEY' not found"
      )
    ).toBe(true)
    expect(
      isRailwayVariableMissingError('RESOLVER_PRIVATE_KEY', "Variable 'OTHER_KEY' not found")
    ).toBe(false)
    expect(isRailwayVariableMissingError('RESOLVER_PRIVATE_KEY', 'Unauthorized')).toBe(false)
  })
})

describe('Railway variable deletion API', () => {
  test('resolves supported API authentication without logging or CLI arguments', () => {
    expect(resolveRailwayAccessToken({ RAILWAY_TOKEN: 'project-token' })).toEqual({
      header: 'project-access-token',
      value: 'project-token'
    })
    expect(resolveRailwayAccessToken({ RAILWAY_API_TOKEN: 'account-token' })).toEqual({
      header: 'authorization',
      value: 'Bearer account-token'
    })
    expect(() => resolveRailwayAccessToken({})).toThrow('RAILWAY_TOKEN or RAILWAY_API_TOKEN')
  })

  test.each(['RESOLVER_PRIVATE_KEY', 'SIMULATION_CALLER_ADDRESS'])(
    'deletes %s without reading Railway variable values',
    async name => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(targetResponse))
        .mockResolvedValueOnce(jsonResponse({ data: { variableDelete: true } }))

      await expect(
        deleteRailwayVariable({ fetcher, name, target: TARGET, token: TOKEN })
      ).resolves.toBe(true)

      expect(fetcher).toHaveBeenCalledTimes(2)
      const requests = fetcher.mock.calls.map(([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '')
      )
      expect(requests.every(request => !request.query.includes('variables('))).toBe(true)
      expect(requests[1]).toMatchObject({
        variables: {
          environmentId: 'environment-id',
          name,
          projectId: 'project-id',
          serviceId: 'service-id'
        }
      })
    }
  )

  test('treats a false direct-delete result as an idempotent no-op', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(targetResponse))
      .mockResolvedValueOnce(jsonResponse({ data: { variableDelete: false } }))

    await expect(
      deleteRailwayVariable({
        fetcher,
        name: 'RESOLVER_PRIVATE_KEY',
        target: TARGET,
        token: TOKEN
      })
    ).resolves.toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test.each([
    jsonResponse({ errors: [{ message: 'secret-bearing upstream failure' }] }),
    jsonResponse({ data: { variableDelete: true } }, 503)
  ])('fails closed with a named sanitized deletion error', async failure => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(targetResponse))
      .mockResolvedValueOnce(failure)

    const result = deleteRailwayVariable({
      fetcher,
      name: 'RESOLVER_PRIVATE_KEY',
      target: TARGET,
      token: TOKEN
    })
    await expect(result).rejects.toMatchObject({ name: 'RailwayVariableOperationError' })
    await expect(result).rejects.toThrow('Failed to delete Railway variable RESOLVER_PRIVATE_KEY')
    await expect(result).rejects.not.toThrow('secret-bearing upstream failure')
  })

  test('uses no Railway variable query or list command that could read raw values', () => {
    const source = readFileSync(new URL('../../scripts/railway.ts', import.meta.url), 'utf8')

    expect(source).not.toContain("'variable',\n  'list'")
    expect(source).not.toContain('railway variable list')
    expect(source).not.toContain('query Variables(')
    expect(source).not.toContain('variables(')
    expect(source).not.toContain('variablesForServiceDeployment')
  })
})

describe('Railway CLI output parsing', () => {
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
