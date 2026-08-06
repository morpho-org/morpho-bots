import { describe, expect, test } from 'bun:test'

import {
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  selectNewRailwayDeployment
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
