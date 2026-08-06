import { describe, expect, test } from 'bun:test'

import {
  COLLECTION_FRAGMENT_VERSION,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  decodePlaygroundFragment,
  deriveBootstrapGraphicModels,
  encodePlaygroundFragment,
  exportBootstrapJson,
  exportBootstrapMarketsEnvValue,
  exportLadderJson,
  exportLadderMarketsEnvValue,
  generateLadderGraphicModels,
  parseCollectionsImport,
  validateBootstrapCollection,
  validateLadderCollection
} from '../../playground/model'

describe('bootstrap + ladder only playground follow-up', () => {
  test('canonical state contains exactly the two ordered collections', () => {
    const state = createDefaultPlaygroundState()
    expect(Object.keys(state)).toEqual(['bootstrap', 'ladder'])
    expect(state.bootstrap.map(item => item.marketId)).toEqual([createDefaultBootstrap().marketId])
    expect(state.ladder.map(item => item.marketId)).toEqual([createDefaultLadder().marketId])
  })

  test('derives a bounded bootstrap reference and surfaces invalid derived semantics', () => {
    const state = createDefaultPlaygroundState()
    state.bootstrap[0]!.minimumRateBps = '200'
    state.bootstrap[0]!.maximumRateBps = '800'
    state.bootstrap[0]!.premiumBps = '-50'
    expect(deriveBootstrapGraphicModels(state.bootstrap)[0]).toMatchObject({
      referenceRateBps: '550',
      quotedRateBps: '500',
      minimumRateBps: '200',
      maximumRateBps: '800'
    })

    state.bootstrap[0]!.minimumRateBps = '0'
    state.bootstrap[0]!.maximumRateBps = '2'
    state.bootstrap[0]!.premiumBps = '0'
    expect(deriveBootstrapGraphicModels(state.bootstrap)[0]?.referenceRateBps).toBe('1')
    state.bootstrap[0]!.maximumRateBps = '0'
    expect(() => deriveBootstrapGraphicModels(state.bootstrap)).toThrow(
      'derived reference and quoted rates'
    )

    state.bootstrap[0] = createDefaultBootstrap()
    state.bootstrap[0].premiumBps = '-1000'
    expect(() => deriveBootstrapGraphicModels(state.bootstrap)).toThrow('configured bounds')
  })

  test('rejects a deterministic ladder reference outside its own configured bounds', () => {
    const state = createDefaultPlaygroundState()
    state.ladder[0]!.quotePremiumBps = '-1000'
    expect(() => generateLadderGraphicModels(state.ladder)).toThrow('configured bounds')
    expect(validateLadderCollection(state.ladder).valid).toBe(false)
  })

  test('keeps higher rung rate, allocation, and cap correspondence under display reversal', () => {
    const state = createDefaultPlaygroundState()
    const ladder = state.ladder[0]!
    ladder.minimumOfferAssets = '1'
    ladder.higherRateBudgetAssets = '997'
    ladder.lowerRateBudgetAssets = '613'
    ladder.targetMarketExposureAssets = '997'
    ladder.maximumTotalExposureAssets = '2000'
    ladder.sizeSkewBps = '1700'
    ladder.rungCount = '3'
    ladder.groupMode = 'shared-rung'
    const shared = generateLadderGraphicModels(state.ladder)[0]!
    expect(
      shared.rungs
        .filter(rung => rung.side === 'higher')
        .map(rung => [rung.rateBps, rung.allocationAssets, rung.offerMaxAssets])
    ).toEqual([
      ['800', '381', '381'],
      ['700', '332', '332'],
      ['600', '284', '284']
    ])
    expect(shared.rungs.every(rung => rung.y >= 0 && rung.y <= 100)).toBe(true)
    expect(shared.callouts.map(callout => callout.label)).toEqual([
      'Center',
      'Spacing & sizing',
      'Budgets',
      'Exposure caps',
      'Grouping',
      'Cadence & tolerance',
      'Hard bounds',
      'Live state'
    ])

    ladder.groupMode = 'per-book'
    const perBook = generateLadderGraphicModels(state.ladder)[0]!
    expect(
      perBook.rungs
        .filter(rung => rung.side === 'higher')
        .map(rung => [rung.rateBps, rung.allocationAssets, rung.offerMaxAssets])
    ).toEqual([
      ['800', '381', '997'],
      ['700', '332', '997'],
      ['600', '284', '997']
    ])
  })

  test('uses an exact bounded versioned fragment with only bootstrap and ladder', () => {
    const state = createDefaultPlaygroundState()
    state.bootstrap.push({ ...createDefaultBootstrap(), marketId: `0x${'6'.repeat(64)}` })
    const fragment = encodePlaygroundFragment(state)
    const payload = JSON.parse(decodeURIComponent(fragment.slice(1)))
    expect(Object.keys(payload)).toEqual(['version', 'bootstrap', 'ladder'])
    expect(payload.version).toBe(COLLECTION_FRAGMENT_VERSION)
    expect(decodePlaygroundFragment(fragment)).toEqual(state)
    expect(() =>
      decodePlaygroundFragment(
        `#${encodeURIComponent(JSON.stringify({ ...payload, referenceRateBps: '500' }))}`
      )
    ).toThrow('unsupported key')
    expect(() => decodePlaygroundFragment(`#${'x'.repeat(140_000)}`)).toThrow('size limit')
  })

  test('accepts strict bootstrap, ladder, combined, and one-layer compact JSON string imports', () => {
    const state = createDefaultPlaygroundState()
    expect(parseCollectionsImport(JSON.stringify(state.bootstrap))).toEqual({
      bootstrap: state.bootstrap
    })
    expect(parseCollectionsImport(JSON.stringify(state.ladder[0]))).toEqual({
      ladder: state.ladder
    })
    expect(
      parseCollectionsImport(JSON.stringify({ bootstrap: state.bootstrap, ladder: state.ladder }))
    ).toEqual(state)
    expect(
      parseCollectionsImport(JSON.stringify(exportBootstrapMarketsEnvValue(state.bootstrap)))
    ).toEqual({ bootstrap: state.bootstrap })
    expect(
      parseCollectionsImport(JSON.stringify(exportLadderMarketsEnvValue(state.ladder)))
    ).toEqual({ ladder: state.ladder })
  })

  test('rejects duplicate, mixed, primitive, and invalid imports atomically', () => {
    const state = createDefaultPlaygroundState()
    expect(() => parseCollectionsImport('{"bootstrap":[],"bootstrap":[]}')).toThrow(
      'duplicate JSON member'
    )
    expect(() => parseCollectionsImport(JSON.stringify('{"ladder":[],"ladder":[]}'))).toThrow(
      'duplicate JSON member'
    )
    expect(() =>
      parseCollectionsImport(JSON.stringify([state.bootstrap[0], state.ladder[0]]))
    ).toThrow('mixed')
    expect(() => parseCollectionsImport('42')).toThrow('supported')
    expect(() => parseCollectionsImport(' '.repeat(128 * 1024 + 1))).toThrow('size limit')
    expect(() =>
      parseCollectionsImport(JSON.stringify({ bootstrap: [], ladder: [], extra: true }))
    ).toThrow('unsupported key')
  })

  test('exports exactly four independently validated collection values', () => {
    const state = createDefaultPlaygroundState()
    expect(exportBootstrapJson(state.bootstrap)).toBe(
      `${JSON.stringify(state.bootstrap, null, 2)}\n`
    )
    expect(exportBootstrapMarketsEnvValue(state.bootstrap)).toBe(JSON.stringify(state.bootstrap))
    expect(exportLadderJson(state.ladder)).toBe(`${JSON.stringify(state.ladder, null, 2)}\n`)
    expect(exportLadderMarketsEnvValue(state.ladder)).toBe(JSON.stringify(state.ladder))

    state.ladder[0]!.stepBps = '0'
    expect(validateBootstrapCollection(state.bootstrap).valid).toBe(true)
    expect(validateLadderCollection(state.ladder).valid).toBe(false)
    expect(() => exportBootstrapJson(state.bootstrap)).not.toThrow()
    expect(() => exportLadderJson(state.ladder)).toThrow('invalid')
  })
})
