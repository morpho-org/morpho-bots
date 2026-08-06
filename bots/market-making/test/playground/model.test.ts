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
    expect(validateLadderCollection(state.ladder).valid).toBe(true)
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

  test('rejects escaped prototype-pollution member names before collection validation', () => {
    const item = JSON.stringify(createDefaultBootstrap())
    for (const unsafeName of ['\\u005f\\u005fproto__', '\\u0063onstructor', '\\u0070rototype']) {
      const unsafe = item.replace('{', `{"${unsafeName}":true,`)
      expect(() => parseCollectionsImport(unsafe), unsafeName).toThrow('unsafe JSON member name')
    }
  })

  test('normalizes Unicode member names and rejects unpaired surrogates deterministically', () => {
    expect(() => parseCollectionsImport('{"é":1,"e\\u0301":2}')).toThrow('duplicate JSON member')
    expect(() => parseCollectionsImport('{"\\ud83d\\ude00":1,"😀":2}')).toThrow(
      'duplicate JSON member'
    )
    expect(() => parseCollectionsImport('{"bootstrap":"\\ud800"}')).toThrow(
      'invalid Unicode surrogate'
    )
  })

  test('does not echo rejected payload member names in import errors', () => {
    const canary = 'PRIVATE_CANARY_DO_NOT_ECHO'
    const payload = JSON.stringify({
      bootstrap: createDefaultPlaygroundState().bootstrap,
      [canary]: true
    })
    let error: unknown
    try {
      parseCollectionsImport(payload)
    } catch (value) {
      error = value
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Object contains an unsupported key')
    expect((error as Error).message).not.toContain(canary)
  })

  test('enforces the exact JSON nesting boundary', () => {
    const nested = (depth: number) => `${'['.repeat(depth)}0${']'.repeat(depth)}`
    const withinBoundary = `{"bootstrap":${nested(127)}}`
    const overBoundary = `{"bootstrap":${nested(128)}}`

    expect(() => parseCollectionsImport(withinBoundary)).not.toThrow('nesting limit')
    expect(() => parseCollectionsImport(overBoundary)).toThrow('nesting limit')
  })

  test('counts exact UTF-8 bytes at the 128 KiB boundary', () => {
    const limit = 128 * 1024
    const valid = JSON.stringify(createDefaultPlaygroundState().bootstrap)
    const exactValid = `${valid}${' '.repeat(limit - new TextEncoder().encode(valid).byteLength)}`
    expect(new TextEncoder().encode(exactValid).byteLength).toBe(limit)
    expect(parseCollectionsImport(exactValid)).toEqual({
      bootstrap: createDefaultPlaygroundState().bootstrap
    })
    expect(() => parseCollectionsImport(`${exactValid} `)).toThrow('size limit')

    const exactMultibyte = `"${'é'.repeat((limit - 2) / 2)}"`
    expect(new TextEncoder().encode(exactMultibyte).byteLength).toBe(limit)
    expect(() => parseCollectionsImport(exactMultibyte)).toThrow('valid JSON')
    expect(() => parseCollectionsImport(`${exactMultibyte}é`)).toThrow('size limit')
  })

  test('rejects a deterministic malformed scanner corpus', () => {
    for (const malformed of [
      '',
      '[',
      '{"a":}',
      '{"a":"\\x"}',
      '01',
      '[1,]',
      '{"a":1,}',
      '"unterminated',
      '{"a":true} trailing'
    ]) {
      expect(() => parseCollectionsImport(malformed), malformed).toThrow('valid JSON')
    }
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

  test('keeps runtime-valid collections exportable when only synthetic previews cannot derive', () => {
    const state = createDefaultPlaygroundState()
    state.bootstrap[0]!.premiumBps = '-1000'
    state.ladder[0]!.quotePremiumBps = '-1000'

    expect(validateBootstrapCollection(state.bootstrap)).toEqual({ valid: true, errors: [] })
    expect(validateLadderCollection(state.ladder)).toEqual({ valid: true, errors: [] })
    expect(exportBootstrapJson(state.bootstrap)).toBe(
      `${JSON.stringify(state.bootstrap, null, 2)}\n`
    )
    expect(exportBootstrapMarketsEnvValue(state.bootstrap)).toBe(JSON.stringify(state.bootstrap))
    expect(exportLadderJson(state.ladder)).toBe(`${JSON.stringify(state.ladder, null, 2)}\n`)
    expect(exportLadderMarketsEnvValue(state.ladder)).toBe(JSON.stringify(state.ladder))
    expect(() => deriveBootstrapGraphicModels(state.bootstrap)).toThrow('configured bounds')
    expect(() => generateLadderGraphicModels(state.ladder)).toThrow('configured bounds')
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
