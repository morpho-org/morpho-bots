import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  parseLatestStatus,
  parseServices,
  resolveProvisioningConfiguration
} from '../../scripts/railway'

describe('Railway provisioning configuration', () => {
  test('supports readonly provisioning without a resolver private key', () => {
    expect(resolveProvisioningConfiguration({ READONLY: 'true' })).toEqual({
      readOnly: true,
      resolverPrivateKey: undefined
    })
  })

  test('wires readonly mode into first-time Railway provisioning', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(deploy).toContain('resolveProvisioningConfiguration(process.env)')
    expect(deploy).toContain('await setVariable(`READONLY=${readOnly}`)')
    expect(deploy).toContain("if (resolverPrivateKey) await setSecret('RESOLVER_PRIVATE_KEY'")
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
