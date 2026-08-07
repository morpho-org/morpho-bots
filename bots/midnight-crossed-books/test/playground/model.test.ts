import { describe, expect, test } from 'bun:test'

import {
  createDefaultPlaygroundState,
  decodePlaygroundFragment,
  encodePlaygroundFragment,
  exportCompactEnvironmentJson,
  exportReadableEnvironmentJson,
  parseStrategyImport,
  toStrategyEnvironment
} from '../../playground/model'
import { parseCrossedBooksStrategyEnvironment } from '../../src/config/strategy-config'

describe('crossed-books configuration playground', () => {
  test('parses only exact pasted strategy JSON, including one compact JSON string layer', () => {
    const state = createDefaultPlaygroundState()

    expect(parseStrategyImport(JSON.stringify(state.strategy))).toEqual(state.strategy)
    expect(parseStrategyImport(JSON.stringify(JSON.stringify(state.strategy)))).toEqual(
      state.strategy
    )
    expect(() =>
      parseStrategyImport(JSON.stringify({ ...state.strategy, RPC_URL: 'https://secret.example' }))
    ).toThrow('unsupported key')
  })

  test('round-trips exact versioned strategy state through the URL fragment', () => {
    const state = createDefaultPlaygroundState()
    state.strategy.maxMatches = '4'

    const fragment = encodePlaygroundFragment(state)
    expect(decodePlaygroundFragment(fragment)).toEqual(state)
    expect(Object.keys(JSON.parse(decodeURIComponent(fragment.slice(1))))).toEqual([
      'version',
      'strategy'
    ])
  })

  test('serializes readable and compact JSON with environment keys in canonical order', () => {
    const state = createDefaultPlaygroundState()
    const environment = {
      MIN_PROFIT_ASSETS: '1',
      MAX_MATCHES: '10',
      SCAN_INTERVAL_MS: '15000'
    }

    expect(toStrategyEnvironment(state.strategy)).toEqual(environment)
    expect(exportReadableEnvironmentJson(state.strategy)).toBe(
      `${JSON.stringify(environment, null, 2)}\n`
    )
    expect(exportCompactEnvironmentJson(state.strategy)).toBe(JSON.stringify(environment))
  })

  test('converts playground values through the same parser used by the crossed-books bot', () => {
    const strategy = {
      minimumProfitAssets: '100',
      maxMatches: '4',
      scanIntervalMs: '30000'
    }

    expect(parseCrossedBooksStrategyEnvironment(toStrategyEnvironment(strategy))).toEqual({
      minimumProfitAssets: 100n,
      maxMatches: 4,
      scanIntervalMs: 30_000
    })
    expect(() =>
      parseCrossedBooksStrategyEnvironment(
        toStrategyEnvironment({ ...strategy, maxMatches: '9007199254740992' })
      )
    ).toThrow('MAX_MATCHES must be a positive safe integer')
  })
})
