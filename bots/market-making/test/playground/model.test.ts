import { describe, expect, test } from 'bun:test'

import {
  BOOTSTRAP_FIELDS,
  BOT_ENVIRONMENT_KEYS,
  LADDER_FIELDS,
  createDefaultPlaygroundState,
  exportEnvironment,
  exportJson,
  exportYaml,
  generatePreviewLadder
} from '../../playground/model'

describe('market-maker parameter playground', () => {
  test('inventories every supported runtime, observability, bootstrap, and ladder field', () => {
    expect(BOT_ENVIRONMENT_KEYS).toEqual([
      'CHAIN_ID',
      'RPC_URL',
      'REFERENCE_RPC_URL',
      'MAKER_PRIVATE_KEY',
      'MAKER_ADDRESS',
      'MIDNIGHT_ADDRESS',
      'LOAN_ASSET_ADDRESS',
      'RATIFIER_ADDRESS',
      'MARKET_IDS',
      'REFERENCE_MARKET_ID',
      'NATIVE_RESERVE_WEI',
      'MAXIMUM_LEND_EXPOSURE_ASSETS',
      'MORPHO_API_BASE_URL',
      'ROUTER_API_BASE_URL',
      'V0_OFFER_GROUP_IDS',
      'REQUEST_TIMEOUT_MS',
      'TRANSACTION_RECEIPT_TIMEOUT_MS',
      'BOOTSTRAP_MARKETS',
      'LADDER_MARKETS',
      'BETTERSTACK_SOURCE_TOKEN',
      'BETTERSTACK_INGESTING_HOST',
      'BETTERSTACK_HEARTBEAT_URL'
    ])

    const state = createDefaultPlaygroundState()
    expect(JSON.stringify(BOOTSTRAP_FIELDS.map(([key]) => key))).toBe(
      JSON.stringify(Object.keys(state.bootstrap))
    )
    expect(JSON.stringify(LADDER_FIELDS.map(([key]) => key))).toBe(
      JSON.stringify(Object.keys(state.ladder))
    )
  })

  test('stays synchronized with source configuration and documented environment inventory', async () => {
    const source = await Bun.file(
      new URL('../../src/config/config-source.utils.ts', import.meta.url)
    ).text()
    const start = source.indexOf('const environmentKeys = [')
    const configured = source
      .slice(start, source.indexOf('] as const', start))
      .match(/'[A-Z][A-Z0-9_]+'/g)
      ?.map(value => value.slice(1, -1))
    const example = await Bun.file(new URL('../../.env.example', import.meta.url)).text()
    const observability = [...example.matchAll(/^(BETTERSTACK_[A-Z_]+)=/gm)].map(
      match => match[1] ?? ''
    )

    expect(JSON.stringify(BOT_ENVIRONMENT_KEYS)).toBe(
      JSON.stringify([
        ...(configured ?? []),
        'BOOTSTRAP_MARKETS',
        'LADDER_MARKETS',
        ...observability
      ])
    )
  })

  test('moves both sides of the ladder immediately when its center, spread, step, or rung count changes', () => {
    const state = createDefaultPlaygroundState()
    const initial = generatePreviewLadder(state)

    state.referenceRateBps = '600'
    state.ladder.spreadBps = '100'
    state.ladder.stepBps = '50'
    state.ladder.rungCount = '2'
    const moved = generatePreviewLadder(state)

    expect(initial.lower.map(rung => rung.rateBps)).toEqual(['400', '300', '200'])
    expect(initial.higher.map(rung => rung.rateBps)).toEqual(['600', '700', '800'])
    expect(moved.lower.map(rung => rung.rateBps)).toEqual(['550', '500'])
    expect(moved.higher.map(rung => rung.rateBps)).toEqual(['650', '700'])
  })

  test('updates YAML, dotenv, and JSON exports from the same edited state', () => {
    const state = createDefaultPlaygroundState()
    state.ladder.quotePremiumBps = '25'
    state.ladder.groupMode = 'per-book'
    state.observability.BETTERSTACK_HEARTBEAT_URL = 'https://uptime.example/heartbeat'

    expect(exportYaml(state)).toContain("quotePremiumBps: '25'")
    expect(exportYaml(state)).toContain("groupMode: 'per-book'")
    expect(exportEnvironment(state)).toContain('LADDER_MARKETS=[{"marketId"')
    expect(exportEnvironment(state)).toContain('"quotePremiumBps":"25"')
    expect(exportEnvironment(state)).toContain(
      'BETTERSTACK_HEARTBEAT_URL=https://uptime.example/heartbeat'
    )
    expect(exportJson(state)).toContain('"quotePremiumBps": "25"')
  })
})
