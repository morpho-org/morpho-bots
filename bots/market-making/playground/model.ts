import type { BootstrapConfig } from '../src/domain/bootstrap/position-bootstrap'
import type { LadderConfig } from '../src/domain/ladder/ladder'

import {
  BOOTSTRAP_MARKET_FIELDS,
  LADDER_MARKET_FIELDS,
  bootstrapConfigsValue,
  ladderConfigsValue,
  parseBytes32
} from '../src/config/market-collections'
import { generateLadder, offerMaxAssetsByRung } from '../src/domain/ladder/ladder'

export type BootstrapInput = Record<
  Exclude<(typeof BOOTSTRAP_MARKET_FIELDS)[number], 'autoRefill'>,
  string
> & { autoRefill: boolean }
export type LadderInput = Record<(typeof LADDER_MARKET_FIELDS)[number], string>

export type PlaygroundState = {
  bootstrap: BootstrapInput[]
  ladder: LadderInput[]
}

export const BOOTSTRAP_FIELDS = [
  ['marketId', 'Market ID', '0x-prefixed bytes32 market', 'text'],
  ['creditTarget', 'Credit target', 'Positive raw credit units', 'number'],
  ['acceptanceAssets', 'Completion threshold', 'Allowed target shortfall', 'number'],
  ['offerSize', 'Pending-offer cap', 'Maximum desired offer assets', 'number'],
  ['premiumBps', 'Quote premium (BPS)', 'Zero or negative reference offset', 'number'],
  ['maximumMarketExposure', 'Market exposure cap', 'Positive raw assets', 'number'],
  ['maximumTotalExposure', 'Total exposure cap', 'Positive raw assets', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive quote floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive quote ceiling', 'number'],
  ['autoRefill', 'Auto-refill', 'Resume after observed completion', 'checkbox']
] as const
export const LADDER_FIELDS = [
  ['marketId', 'Market ID', '0x-prefixed bytes32 market', 'text'],
  ['quotePremiumBps', 'Quote premium (BPS)', 'Signed center offset', 'number'],
  ['spreadBps', 'Full spread (BPS)', 'Positive even nearest-rung distance', 'number'],
  ['stepBps', 'Step (BPS)', 'Positive same-side rung distance', 'number'],
  ['rungCount', 'Rungs per side', '1–512', 'number'],
  ['sizeSkewBps', 'Size skew (BPS)', 'Signed outer-rung weight change', 'number'],
  ['lowerRateBudgetAssets', 'Lower-rate budget', 'Positive reduce-only budget', 'number'],
  ['higherRateBudgetAssets', 'Higher-rate budget', 'Positive lend budget', 'number'],
  ['targetMarketExposureAssets', 'Target market exposure', 'Positive market cap', 'number'],
  ['maximumTotalExposureAssets', 'Maximum total exposure', 'Positive strategy cap', 'number'],
  ['minimumOfferAssets', 'Minimum offer assets', 'Positive emitted-rung floor', 'number'],
  ['groupMode', 'Group mode', 'shared-rung or per-book', 'select'],
  ['loopIntervalSeconds', 'Cadence (seconds)', '1–2147483', 'number'],
  ['movementToleranceBps', 'Movement tolerance (BPS)', 'Non-negative deadband', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive hard floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive hard ceiling', 'number']
] as const

const DEFAULT_MARKET_ID = `0x${'5'.repeat(64)}`

export const createDefaultBootstrap = (marketId = DEFAULT_MARKET_ID): BootstrapInput => ({
  marketId,
  creditTarget: '10000000000',
  acceptanceAssets: '100000000',
  offerSize: '500000000',
  premiumBps: '-50',
  maximumMarketExposure: '20000000000',
  maximumTotalExposure: '30000000000',
  minimumRateBps: '200',
  maximumRateBps: '800',
  autoRefill: false
})

export const createDefaultLadder = (marketId = DEFAULT_MARKET_ID): LadderInput => ({
  marketId,
  quotePremiumBps: '0',
  spreadBps: '200',
  stepBps: '100',
  rungCount: '3',
  sizeSkewBps: '0',
  lowerRateBudgetAssets: '10000000000',
  higherRateBudgetAssets: '10000000000',
  targetMarketExposureAssets: '20000000000',
  maximumTotalExposureAssets: '30000000000',
  minimumOfferAssets: '101000000',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '60',
  movementToleranceBps: '10',
  minimumRateBps: '200',
  maximumRateBps: '800'
})

export const createDefaultPlaygroundState = (): PlaygroundState => ({
  bootstrap: [createDefaultBootstrap()],
  ladder: [createDefaultLadder()]
})

const bootstrapInput = (config: BootstrapConfig): BootstrapInput => ({
  marketId: config.marketId,
  creditTarget: String(config.creditTarget),
  acceptanceAssets: String(config.acceptanceAssets),
  offerSize: String(config.offerSize),
  premiumBps: String(config.premiumBps),
  maximumMarketExposure: String(config.maximumMarketExposure),
  maximumTotalExposure: String(config.maximumTotalExposure),
  minimumRateBps: String(config.minimumRateBps),
  maximumRateBps: String(config.maximumRateBps),
  autoRefill: config.autoRefill
})

const ladderInput = (config: LadderConfig): LadderInput => ({
  marketId: config.marketId,
  quotePremiumBps: String(config.quotePremiumBps),
  spreadBps: String(config.spreadBps),
  stepBps: String(config.stepBps),
  rungCount: String(config.rungCount),
  sizeSkewBps: String(config.sizeSkewBps),
  lowerRateBudgetAssets: String(config.lowerRateBudgetAssets),
  higherRateBudgetAssets: String(config.higherRateBudgetAssets),
  targetMarketExposureAssets: String(config.targetMarketExposureAssets),
  maximumTotalExposureAssets: String(config.maximumTotalExposureAssets),
  minimumOfferAssets: String(config.minimumOfferAssets),
  groupMode: config.groupMode,
  loopIntervalSeconds: String(config.loopIntervalSeconds),
  movementToleranceBps: String(config.movementToleranceBps),
  minimumRateBps: String(config.minimumRateBps),
  maximumRateBps: String(config.maximumRateBps)
})

const allowlist = (items: readonly { marketId: string }[]) =>
  items.map((item, index) => parseBytes32(item.marketId, `collection[${index}].marketId`))

const parseBootstrap = (value: unknown) => {
  const items = value as BootstrapInput[]
  return bootstrapConfigsValue(value, allowlist(Array.isArray(items) ? items : [])).map(
    bootstrapInput
  )
}
const parseLadder = (value: unknown) => {
  const items = value as LadderInput[]
  return ladderConfigsValue(value, allowlist(Array.isArray(items) ? items : [])).map(ladderInput)
}

export type CollectionValidation = { valid: boolean; errors: string[] }
const validation = (operation: () => unknown): CollectionValidation => {
  try {
    operation()
    return { valid: true, errors: [] }
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid collection'] }
  }
}
export const validateBootstrapCollection = (items: BootstrapInput[]) =>
  validation(() => deriveBootstrapGraphicModels(items))
export const validateLadderCollection = (items: LadderInput[]) =>
  validation(() => generateLadderGraphicModels(items))

export type BootstrapGraphicModel = {
  marketId: string
  referenceRateBps: string
  quotedRateBps: string
  minimumRateBps: string
  maximumRateBps: string
  creditTarget: string
  acceptedCredit: string
  offerSize: string
  callouts: { label: string; value: string }[]
}

/** Derives a synthetic reference whose premium-adjusted quote is the integer midpoint of the bounds. */
export const deriveBootstrapGraphicModels = (items: BootstrapInput[]): BootstrapGraphicModel[] =>
  parseBootstrap(items).map(item => {
    const minimum = BigInt(item.minimumRateBps)
    const maximum = BigInt(item.maximumRateBps)
    const quoted = (minimum + maximum) / 2n
    const reference = quoted - BigInt(item.premiumBps)
    if (
      reference <= 0n ||
      reference < minimum ||
      reference > maximum ||
      reference + BigInt(item.premiumBps) < minimum ||
      reference + BigInt(item.premiumBps) > maximum
    ) {
      throw new Error(
        'Bootstrap derived reference and quoted rates must be positive and remain inside configured bounds'
      )
    }
    return {
      marketId: item.marketId,
      referenceRateBps: String(reference),
      quotedRateBps: String(quoted),
      minimumRateBps: item.minimumRateBps,
      maximumRateBps: item.maximumRateBps,
      creditTarget: item.creditTarget,
      acceptedCredit: String(BigInt(item.creditTarget) - BigInt(item.acceptanceAssets)),
      offerSize: item.offerSize,
      callouts: [
        {
          label: 'Credit target',
          value: `${item.creditTarget} target; complete at ${BigInt(item.creditTarget) - BigInt(item.acceptanceAssets)}`
        },
        {
          label: 'Refill behavior',
          value: item.autoRefill
            ? 'Auto-refill enabled after completion'
            : 'One-shot; observe after completion'
        },
        { label: 'Cadence', value: '60 seconds (fixed bootstrap monitor cadence)' },
        { label: 'Movement tolerance', value: '0 BPS; changed valid terms are reconciled' },
        { label: 'Pending-offer cap', value: `${item.offerSize} assets before live capacity caps` },
        {
          label: 'Failure threshold',
          value: '1 failed cycle halts monitoring and triggers owned-group cleanup'
        },
        {
          label: 'Exposure caps',
          value: `${item.maximumMarketExposure} market · ${item.maximumTotalExposure} total`
        },
        { label: 'Live state', value: 'No live offers, balances, positions, book, or network data' }
      ]
    }
  })

export type LadderGraphicRung = {
  index: number
  rateBps: string
  allocationAssets: string
  offerMaxAssets: string
  side: 'higher' | 'lower'
  sideLabel: 'Lend' | 'Reduce-only'
  y: number
  allocationBarRatio: number
  offerMaxBarRatio: number
}
export type LadderGraphicModel = {
  marketId: string
  minimumRateBps: string
  maximumRateBps: string
  referenceRateBps: string
  centerRateBps: string
  axis: {
    minimumRateBps: string
    maximumRateBps: string
    referenceRateBps: string
    centerRateBps: string
  }
  gapBps: string
  plotHeight: number
  rateToY: (rateBps: string) => number
  rungs: LadderGraphicRung[]
  callouts: { label: string; value: string; parameters: string[] }[]
}

const collectionFromArgument = (value: LadderInput[] | PlaygroundState) =>
  Array.isArray(value) ? value : value.ladder

/** Generates each ladder around the bounded midpoint, preserving rung/cap pairing when displayed high-to-low. */
export const generateLadderGraphicModels = (
  value: LadderInput[] | PlaygroundState
): LadderGraphicModel[] =>
  parseLadder(collectionFromArgument(value)).map(input => {
    const config = ladderConfigsValue(
      [input],
      [parseBytes32(input.marketId, 'ladder[0].marketId')]
    )[0]!
    const minimum = config.minimumRateBps
    const maximum = config.maximumRateBps
    const center = (minimum + maximum) / 2n
    const reference = center - config.quotePremiumBps
    if (reference <= 0n || reference < minimum || reference > maximum) {
      throw new Error(
        'Ladder derived reference and center rates must remain inside configured bounds'
      )
    }
    const generated = generateLadder({ config, referenceRateBps: reference })
    const caps = offerMaxAssetsByRung(generated)
    const paired = (side: 'higher' | 'lower') => {
      const rungs = generated[side]
      const sideCaps = caps[side]
      return rungs.map((rung, index) => ({ rung, cap: sideCaps[index]! }))
    }
    const rows = [
      ...paired('higher')
        .toReversed()
        .map(({ rung, cap }) => ({
          rung,
          cap,
          side: 'higher' as const,
          sideLabel: 'Lend' as const
        })),
      ...paired('lower').map(({ rung, cap }) => ({
        rung,
        cap,
        side: 'lower' as const,
        sideLabel: 'Reduce-only' as const
      }))
    ]
    const range = maximum - minimum
    const plotHeight = 100
    const rateToY = (rate: string) => Number(((maximum - BigInt(rate)) * 10_000n) / range) / 100
    const largest = rows.reduce(
      (result, row) => (row.rung.assets > result ? row.rung.assets : result),
      1n
    )
    const ratio = (amount: bigint) => Number((amount * 10_000n) / largest) / 10_000
    return {
      marketId: input.marketId,
      minimumRateBps: input.minimumRateBps,
      maximumRateBps: input.maximumRateBps,
      referenceRateBps: String(reference),
      centerRateBps: String(generated.centerRateBps),
      axis: {
        minimumRateBps: input.minimumRateBps,
        maximumRateBps: input.maximumRateBps,
        referenceRateBps: String(reference),
        centerRateBps: String(generated.centerRateBps)
      },
      gapBps: input.spreadBps,
      plotHeight,
      rateToY,
      rungs: rows.map(({ rung, cap, side, sideLabel }) => ({
        index: rung.index,
        rateBps: String(rung.rateBps),
        allocationAssets: String(rung.assets),
        offerMaxAssets: String(cap),
        side,
        sideLabel,
        y: rateToY(String(rung.rateBps)),
        allocationBarRatio: ratio(rung.assets),
        offerMaxBarRatio: ratio(cap)
      })),
      callouts: [
        {
          label: 'Center',
          value: `${reference} + ${config.quotePremiumBps} = ${generated.centerRateBps} BPS`,
          parameters: ['quotePremiumBps']
        },
        {
          label: 'Spacing & sizing',
          value: `${config.spreadBps} BPS spread · ${config.stepBps} BPS step · ${config.rungCount} rungs/side · ${config.sizeSkewBps} BPS skew · ${config.minimumOfferAssets} asset floor`,
          parameters: ['spreadBps', 'stepBps', 'rungCount', 'sizeSkewBps', 'minimumOfferAssets']
        },
        {
          label: 'Budgets',
          value: `${config.lowerRateBudgetAssets} reduce-only · ${config.higherRateBudgetAssets} lend`,
          parameters: ['lowerRateBudgetAssets', 'higherRateBudgetAssets']
        },
        {
          label: 'Exposure caps',
          value: `${config.targetMarketExposureAssets} target · ${config.maximumTotalExposureAssets} total`,
          parameters: ['targetMarketExposureAssets', 'maximumTotalExposureAssets']
        },
        {
          label: 'Grouping',
          value: config.groupMode,
          parameters: ['groupMode']
        },
        {
          label: 'Cadence & tolerance',
          value: `${config.loopIntervalSeconds}s cadence · ${config.movementToleranceBps} BPS movement tolerance`,
          parameters: ['loopIntervalSeconds', 'movementToleranceBps']
        },
        {
          label: 'Hard bounds',
          value: `${config.minimumRateBps}–${config.maximumRateBps} BPS`,
          parameters: ['minimumRateBps', 'maximumRateBps']
        },
        {
          label: 'Live state',
          value:
            'No live offers, balances, positions, book, capacity, persistence, or network data',
          parameters: []
        }
      ]
    }
  })

const MAXIMUM_COLLECTION_JSON_BYTES = 128 * 1024
const MAXIMUM_JSON_NESTING = 128
class StrictJsonError extends Error {}
class ScannerSyntaxError extends Error {}

/** Detects duplicate object names before JSON.parse can overwrite them. */
const assertNoDuplicateJsonMembers = (text: string) => {
  let position = 0
  const syntax = (): never => {
    throw new ScannerSyntaxError()
  }
  const whitespace = () => {
    while (/\s/.test(text[position] ?? '')) position++
  }
  const string = (): string => {
    const start = position
    if (text[position++] !== '"') syntax()
    while (position < text.length) {
      const character = text[position++]!
      if (character === '"') {
        const encoded = text.slice(start, position)
        try {
          return JSON.parse(encoded) as string
        } catch {
          return syntax()
        }
      }
      if (character === '\\') {
        const escape = text[position++]
        if (escape === 'u') {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(position, position + 4))) syntax()
          position += 4
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) syntax()
      } else if (character.charCodeAt(0) <= 0x1f) syntax()
    }
    return syntax()
  }
  const value = (depth: number): void => {
    whitespace()
    if (text[position] === '"') {
      string()
      return
    }
    if (text[position] === '{') {
      if (depth >= MAXIMUM_JSON_NESTING) throw new StrictJsonError('JSON exceeds the nesting limit')
      position++
      whitespace()
      const names = new Set<string>()
      if (text[position] === '}') {
        position++
        return
      }
      while (position < text.length) {
        whitespace()
        const name = string().normalize('NFC')
        if (names.has(name))
          throw new StrictJsonError('Import contains duplicate JSON member names')
        names.add(name)
        whitespace()
        if (text[position++] !== ':') syntax()
        value(depth + 1)
        whitespace()
        const separator = text[position++]
        if (separator === '}') return
        if (separator !== ',') syntax()
      }
      syntax()
    }
    if (text[position] === '[') {
      if (depth >= MAXIMUM_JSON_NESTING) throw new StrictJsonError('JSON exceeds the nesting limit')
      position++
      whitespace()
      if (text[position] === ']') {
        position++
        return
      }
      while (position < text.length) {
        value(depth + 1)
        whitespace()
        const separator = text[position++]
        if (separator === ']') return
        if (separator !== ',') syntax()
      }
      syntax()
    }
    const token = text
      .slice(position)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
    if (token === undefined) throw new ScannerSyntaxError()
    position += token.length
  }
  try {
    value(0)
    whitespace()
    if (position !== text.length) syntax()
  } catch (error) {
    if (!(error instanceof ScannerSyntaxError)) throw error
  }
}

const parseJson = (text: string): unknown => {
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_COLLECTION_JSON_BYTES) {
    throw new StrictJsonError('Collection JSON exceeds the 128 KiB size limit')
  }
  assertNoDuplicateJsonMembers(text)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Import must be valid JSON')
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (record: Record<string, unknown>, allowed: readonly string[]) => {
  const unsupported = Object.keys(record).find(key => !allowed.includes(key))
  if (unsupported) throw new Error(`Object contains an unsupported key: ${unsupported}`)
}
const itemKind = (value: unknown): 'bootstrap' | 'ladder' => {
  if (!plainObject(value)) throw new Error('Import item must be a supported collection object')
  const keys = Object.keys(value)
  const bootstrap =
    keys.every(key => BOOTSTRAP_MARKET_FIELDS.includes(key as never)) && keys.includes('autoRefill')
  const ladder =
    keys.every(key => LADDER_MARKET_FIELDS.includes(key as never)) && keys.includes('groupMode')
  if (bootstrap === ladder)
    throw new Error('Import item is not a supported exact collection object')
  return bootstrap ? 'bootstrap' : 'ladder'
}

export type CollectionsImport = Partial<Pick<PlaygroundState, 'bootstrap' | 'ladder'>>
export const parseCollectionsImport = (text: string): CollectionsImport => {
  let parsed = parseJson(text)
  if (typeof parsed === 'string') parsed = parseJson(parsed)
  if (typeof parsed === 'string') throw new Error('Import accepts at most one JSON string layer')
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error('Empty array is not a supported unlabelled import')
    const kinds = parsed.map(itemKind)
    if (new Set(kinds).size !== 1)
      throw new Error('Import cannot contain mixed collection item types')
    return kinds[0] === 'bootstrap'
      ? { bootstrap: parseBootstrap(parsed) }
      : { ladder: parseLadder(parsed) }
  }
  if (!plainObject(parsed)) throw new Error('Import must use a supported collection shape')
  const keys = Object.keys(parsed)
  if (keys.includes('bootstrap') || keys.includes('ladder')) {
    exactKeys(parsed, ['bootstrap', 'ladder'])
    if (keys.length === 0) throw new Error('Import must contain a supported collection')
    const result: CollectionsImport = {}
    if ('bootstrap' in parsed) result.bootstrap = parseBootstrap(parsed.bootstrap)
    if ('ladder' in parsed) result.ladder = parseLadder(parsed.ladder)
    return result
  }
  const kind = itemKind(parsed)
  return kind === 'bootstrap'
    ? { bootstrap: parseBootstrap([parsed]) }
    : { ladder: parseLadder([parsed]) }
}

export const COLLECTION_FRAGMENT_VERSION = 1
export const encodePlaygroundFragment = (state: PlaygroundState) => {
  const validation = validatePlaygroundState(state)
  if (!validation.valid)
    throw new Error(`Fragment state is invalid: ${validation.errors.join('; ')}`)
  const canonical = {
    version: COLLECTION_FRAGMENT_VERSION,
    bootstrap: parseBootstrap(state.bootstrap),
    ladder: parseLadder(state.ladder)
  }
  const encoded = encodeURIComponent(JSON.stringify(canonical))
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_COLLECTION_JSON_BYTES) {
    throw new Error('Fragment exceeds the 128 KiB size limit')
  }
  return `#${encoded}`
}
export const decodePlaygroundFragment = (fragment: string): PlaygroundState => {
  const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (encoded === '') return createDefaultPlaygroundState()
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_COLLECTION_JSON_BYTES) {
    throw new Error('Fragment exceeds the 128 KiB size limit')
  }
  let text: string
  try {
    text = decodeURIComponent(encoded)
  } catch {
    throw new Error('Fragment must be valid percent-encoded JSON')
  }
  const parsed = parseJson(text)
  if (!plainObject(parsed)) throw new Error('Fragment payload must be an object')
  exactKeys(parsed, ['version', 'bootstrap', 'ladder'])
  if (Object.keys(parsed).length !== 3)
    throw new Error('Fragment payload is missing a required key')
  if (parsed.version !== COLLECTION_FRAGMENT_VERSION)
    throw new Error('Unsupported fragment version')
  const state = { bootstrap: parseBootstrap(parsed.bootstrap), ladder: parseLadder(parsed.ladder) }
  const validation = validatePlaygroundState(state)
  if (!validation.valid)
    throw new Error(`Fragment state is invalid: ${validation.errors.join('; ')}`)
  return state
}

const assertValid = <T>(items: T[], validate: (items: T[]) => CollectionValidation) => {
  const result = validate(items)
  if (!result.valid) throw new Error(`Collection is invalid: ${result.errors.join('; ')}`)
}
export const exportBootstrapJson = (items: BootstrapInput[]) => {
  assertValid(items, validateBootstrapCollection)
  return `${JSON.stringify(items, null, 2)}\n`
}
export const exportBootstrapMarketsEnvValue = (items: BootstrapInput[]) => {
  assertValid(items, validateBootstrapCollection)
  return JSON.stringify(items)
}
export const exportLadderJson = (items: LadderInput[]) => {
  assertValid(items, validateLadderCollection)
  return `${JSON.stringify(items, null, 2)}\n`
}
export const exportLadderMarketsEnvValue = (value: LadderInput[] | PlaygroundState) => {
  const items = collectionFromArgument(value)
  assertValid(items, validateLadderCollection)
  return JSON.stringify(items)
}

export const validatePlaygroundState = (state: PlaygroundState) => {
  const bootstrap = validateBootstrapCollection(state.bootstrap)
  const ladder = validateLadderCollection(state.ladder)
  return { valid: bootstrap.valid && ladder.valid, errors: [...bootstrap.errors, ...ladder.errors] }
}
