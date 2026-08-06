import { describe, expect, test } from 'bun:test'

import {
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  parseRailwayVolumes,
  selectNewRailwayDeployment,
  synchronizedOptionalRailwayVariables
} from '../../scripts/railway.utils'

describe('Railway CLI output parsing', () => {
  test('parses named services from array and wrapped response shapes', () => {
    const array = JSON.stringify([{ name: 'market-making' }, { id: 'nameless' }])
    const wrapped = JSON.stringify({ services: [{ serviceName: 'market-making' }] })

    expect(parseRailwayServices(array)).toEqual([{ name: 'market-making' }])
    expect(parseRailwayServices(wrapped)).toEqual([{ name: 'market-making' }])
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

  test('synchronizes every optional variable with explicit safe defaults', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        LADDER_MARKETS: '  [{"marketId":"configured"}]  ',
        REQUEST_TIMEOUT_MS: '25000'
      })
    )

    expect(variables).toEqual({
      BETTERSTACK_HEARTBEAT_URL: ' ',
      BETTERSTACK_INGESTING_HOST: ' ',
      BETTERSTACK_SOURCE_TOKEN: ' ',
      BOOTSTRAP_MARKETS: '[]',
      LADDER_MARKETS: '[{"marketId":"configured"}]',
      REQUEST_TIMEOUT_MS: '25000',
      TRANSACTION_RECEIPT_TIMEOUT_MS: '180000',
      V0_OFFER_GROUP_IDS: ' '
    })
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
