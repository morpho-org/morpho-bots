import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  assertFreshRailwayReferenceProvisioning,
  assertFullRailwaySignerProvisioning,
  isNonEmptyJsonArray,
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  parseRailwayVolumes,
  selectNewRailwayDeployment,
  synchronizedOptionalRailwayVariables
} from '../../scripts/railway.utils'

describe('Railway CLI output parsing', () => {
  test('fails closed for signer modes that require out-of-band Railway provisioning', () => {
    expect(() => assertFullRailwaySignerProvisioning('private-key')).not.toThrow()
    expect(() => assertFullRailwaySignerProvisioning('keystore')).toThrow(
      'Keystore Railway deployment requires a pre-provisioned file; use DEPLOY_ONLY=true'
    )
    expect(() => assertFullRailwaySignerProvisioning('aws')).toThrow(
      'AWS KMS Railway deployment requires pre-provisioned credentials; use DEPLOY_ONLY=true'
    )
  })

  test('identifies only populated JSON arrays as deployable strategy lists', () => {
    expect(isNonEmptyJsonArray('[{"marketId":"configured"}]')).toBe(true)
    expect(isNonEmptyJsonArray('[]')).toBe(false)
    expect(isNonEmptyJsonArray('{"marketId":"configured"}')).toBe(false)
    expect(isNonEmptyJsonArray('not-json')).toBe(false)
  })

  test('parses named services from array and wrapped response shapes', () => {
    const array = JSON.stringify([{ id: 'service-id', name: 'market-making' }, { id: 'nameless' }])
    const wrapped = JSON.stringify({
      services: [{ id: 'service-id', serviceName: 'market-making' }]
    })
    const created = JSON.stringify({ id: 'service-id', name: 'market-making' })

    expect(parseRailwayServices(array)).toEqual([{ id: 'service-id', name: 'market-making' }])
    expect(parseRailwayServices(wrapped)).toEqual([{ id: 'service-id', name: 'market-making' }])
    expect(parseRailwayServices(created)).toEqual([{ id: 'service-id', name: 'market-making' }])
  })

  test('returns no services for malformed JSON', () => {
    expect(parseRailwayServices('not-json')).toEqual([])
  })

  test('parses only complete attached Railway volumes', () => {
    const raw = JSON.stringify({
      volumes: [
        {
          id: 'volume-id',
          isPendingDeletion: false,
          mountPath: '/state',
          serviceName: 'market-making'
        },
        { id: 'unattached', isPendingDeletion: false, mountPath: '/other', serviceName: null },
        { id: 'incomplete', mountPath: '/other', serviceName: 'market-making' }
      ]
    })

    expect(parseRailwayVolumes(raw)).toEqual([
      {
        id: 'volume-id',
        isPendingDeletion: false,
        mountPath: '/state',
        serviceName: 'market-making'
      }
    ])
    expect(parseRailwayVolumes('not-json')).toEqual([])
  })

  test('requires Blue references when provisioning a fresh variable-rate service', () => {
    const environment = {
      BOOTSTRAP_MARKETS: JSON.stringify([
        { marketId: 'configured', targetRate: { strategy: 'variable_rate_avg' } }
      ]),
      LADDER_MARKETS: JSON.stringify([
        {
          marketId: 'configured',
          targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
        }
      ])
    }

    expect(() => assertFreshRailwayReferenceProvisioning(environment, true)).toThrow(
      'Missing required environment variable: REFERENCE_RPC_URL'
    )
    expect(() => assertFreshRailwayReferenceProvisioning(environment, false)).not.toThrow()
    expect(() =>
      assertFreshRailwayReferenceProvisioning(
        {
          ...environment,
          REFERENCE_RPC_URL: 'https://archive.example',
          REFERENCE_MARKET_ID: '0xreference'
        },
        true
      )
    ).not.toThrow()
  })

  test('checks fresh-service references before Railway can create the service', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeGreaterThan(-1)
    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeLessThan(deploy.indexOf('railway add --service'))
  })

  test('runs the volume-backed service as root before starting every deployment', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const configureRunUid = "setRuntimeVariable(['RAILWAY_RUN_UID', '0'])"

    expect(deploy).toContain(configureRunUid)
    expect(deploy.indexOf(configureRunUid)).toBeLessThan(deploy.indexOf('if (!DEPLOY_ONLY)'))
    expect(deploy.indexOf(configureRunUid)).toBeLessThan(deploy.indexOf('await startDeployment()'))
  })

  test('synchronizes every optional variable with explicit safe defaults', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        REQUEST_TIMEOUT_MS: '25000'
      })
    )

    expect(variables).toEqual({
      BETTERSTACK_HEARTBEAT_URL: ' ',
      BETTERSTACK_INGESTING_HOST: ' ',
      BETTERSTACK_SOURCE_TOKEN: ' ',
      REFERENCE_MARKET_ID: ' ',
      REFERENCE_RPC_URL: ' ',
      REQUEST_TIMEOUT_MS: '25000',
      TRANSACTION_RECEIPT_TIMEOUT_MS: '180000',
      V0_OFFER_GROUP_IDS: ' '
    })
  })

  test('trims optional reference configuration before uploading it to Railway', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        REFERENCE_RPC_URL: ' https://archive.example/ ',
        REFERENCE_MARKET_ID: ' 0xreference '
      })
    )

    expect(variables.REFERENCE_RPC_URL).toBe('https://archive.example/')
    expect(variables.REFERENCE_MARKET_ID).toBe('0xreference')
  })

  test('preserves Railway reference variables when a workflow uses a variable rate', () => {
    for (const targetRate of [undefined, { strategy: 'variable_rate_avg' }]) {
      const variables = Object.fromEntries(
        synchronizedOptionalRailwayVariables({
          BOOTSTRAP_MARKETS: JSON.stringify([{ marketId: 'configured', targetRate }]),
          LADDER_MARKETS: JSON.stringify([
            {
              marketId: 'configured',
              targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
            }
          ])
        })
      )

      expect(variables).not.toHaveProperty('REFERENCE_RPC_URL')
      expect(variables).not.toHaveProperty('REFERENCE_MARKET_ID')
    }
  })

  test('allows Compose deployments to omit inactive reference configuration', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

    expect(compose).toContain('REFERENCE_RPC_URL: ${REFERENCE_RPC_URL:-}')
    expect(compose).toContain('REFERENCE_MARKET_ID: ${REFERENCE_MARKET_ID:-}')
  })

  test('reads the newest complete deployment and rejects incomplete output', () => {
    const raw = JSON.stringify({
      deployments: [
        { id: 'new', status: 'DEPLOYING' },
        { id: 'old', status: 'SUCCESS' }
      ]
    })

    expect(parseLatestRailwayDeployment(raw)).toEqual({ id: 'new', status: 'DEPLOYING' })
    expect(parseLatestRailwayDeployment('[{"status":"SUCCESS"}]')).toBeUndefined()
    expect(parseLatestRailwayDeployment('not-json')).toBeUndefined()
  })

  test('does not mistake the previous successful deployment for the new upload', () => {
    const previous = JSON.stringify([{ id: 'existing', status: 'SUCCESS' }])
    const current = JSON.stringify([{ id: 'created', status: 'BUILDING' }])

    expect(selectNewRailwayDeployment(previous, 'existing')).toBeUndefined()
    expect(selectNewRailwayDeployment(current, 'existing')).toEqual({
      id: 'created',
      status: 'BUILDING'
    })
  })

  test('recognizes only handled terminal Railway statuses', () => {
    expect(isTerminalRailwayDeploymentStatus('SUCCESS')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('CRASHED')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('NEEDS_APPROVAL')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('DEPLOYING')).toBe(false)
    expect(isTerminalRailwayDeploymentStatus('UNKNOWN')).toBe(false)
  })
})
