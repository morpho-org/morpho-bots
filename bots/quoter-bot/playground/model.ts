import type { BootstrapConfig } from '../src/domain/bootstrap/position-bootstrap'
import type { LadderConfig } from '../src/domain/ladder/ladder'
import type { MaturityPremiumConfig } from '../src/domain/maturity-premium'
import type { TargetRateConfigured } from '../src/domain/target-rate'
import type { ReferenceBand } from './reference-response.utils'

import {
  BOOTSTRAP_MARKET_FIELDS,
  LADDER_MARKET_FIELDS,
  bootstrapConfigsValue,
  ladderConfigsValue,
  parseBytes32
} from '../src/config/market-collections'
import { clampRateBps } from '../src/domain/cross-book'
import { generateLadder, offerMaxAssetsByRung } from '../src/domain/ladder/ladder'
import { highestReachableMaturityPremiumBps } from '../src/domain/maturity-premium'
import { CollectionImportError } from './collection-import.error'
import { CollectionValidationError } from './collection-validation.error'
import { FragmentCodecError } from './fragment-codec.error'
import { bootstrapReferenceBand, ladderReferenceBand } from './reference-response.utils'
import { StrictJsonError } from './strict-json.error'

export type TargetRateInput =
  | { strategy: 'variable_rate_avg' }
  | { strategy: 'hardcoded'; hardcodedRateBps: string }
export type MaturityPremiumInput = {
  shape: 'linear'
  premiumPerYearBps: string
  maximumPremiumBps?: string
}
export type BootstrapInput = Record<
  Exclude<
    (typeof BOOTSTRAP_MARKET_FIELDS)[number],
    'autoRefill' | 'targetRate' | 'maturityPremium'
  >,
  string
> & { autoRefill: boolean; targetRate: TargetRateInput; maturityPremium?: MaturityPremiumInput }
export type LadderInput = Record<
  Exclude<(typeof LADDER_MARKET_FIELDS)[number], 'targetRate' | 'maturityPremium'>,
  string
> & { targetRate: TargetRateInput; maturityPremium?: MaturityPremiumInput }

export type PlaygroundState = {
  bootstrap: BootstrapInput[]
  ladder: LadderInput[]
}

/**
 * Formats one raw asset or credit amount for display.
 * @param rawAmount - Exact raw integer amount as configured and exported.
 * @returns The display amount; the identity formatter keeps the exact raw integer.
 * @remarks One formatter serves every entry in both collections: each amount is a raw
 * smallest-unit amount of the single configured `loanAsset` shared by all configured markets.
 */
export type AssetFormatter = (rawAmount: string) => string
const rawAssetFormatter: AssetFormatter = rawAmount => rawAmount

export const BOOTSTRAP_FIELDS = [
  ['marketId', 'Market ID', '0x-prefixed 32-byte Midnight market id', 'text'],
  [
    'targetRate.strategy',
    'Target rate source',
    '6-hour average supply APY on the reference Blue market, or a fixed rate you set',
    'target-rate-select'
  ],
  [
    'targetRate.hardcodedRateBps',
    'Fixed target rate (BPS)',
    'Used instead of the market rate when the source is hardcoded',
    'target-rate-number'
  ],
  ['creditTarget', 'Credit target', 'How much credit to build in this market', 'number'],
  [
    'acceptanceAssets',
    'Allowed shortfall',
    'Stop this far below the target; completion is target minus this',
    'number'
  ],
  [
    'offerSize',
    'Maximum offer size',
    'Largest single offer; also capped by remaining target, cash and exposure',
    'number'
  ],
  [
    'premiumBps',
    'Quote premium (BPS)',
    'Added to the market rate to get your quote; zero or negative',
    'number'
  ],
  [
    'maturityPremium',
    'Maturity premium',
    'Optional extra rate that grows with time left to maturity',
    'maturity-premium-select'
  ],
  [
    'maturityPremium.premiumPerYearBps',
    'Premium per year (BPS)',
    'Extra rate added per year left to maturity',
    'maturity-premium-number'
  ],
  [
    'maturityPremium.maximumPremiumBps',
    'Premium cap (BPS)',
    'Optional ceiling on that extra rate',
    'maturity-premium-number'
  ],
  ['maximumMarketExposure', 'Market exposure cap', 'Most this market may hold', 'number'],
  [
    'maximumTotalExposure',
    'Total exposure cap',
    'Most every configured market may hold together',
    'number'
  ],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Quotes never go below this', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Quotes never go above this', 'number'],
  ['autoRefill', 'Auto-refill', 'Lend again if the position later falls below target', 'checkbox']
] as const
export const LADDER_FIELDS = [
  ['marketId', 'Market ID', '0x-prefixed 32-byte Midnight market id', 'text'],
  [
    'targetRate.strategy',
    'Target rate source',
    '6-hour average supply APY on the reference Blue market, or a fixed rate you set',
    'target-rate-select'
  ],
  [
    'targetRate.hardcodedRateBps',
    'Fixed target rate (BPS)',
    'Used instead of the market rate when the source is hardcoded',
    'target-rate-number'
  ],
  [
    'quotePremiumBps',
    'Quote premium (BPS)',
    'Shifts the ladder centre off the market rate; may be negative',
    'number'
  ],
  [
    'maturityPremium',
    'Maturity premium',
    'Optional extra rate that grows with time left to maturity',
    'maturity-premium-select'
  ],
  [
    'maturityPremium.premiumPerYearBps',
    'Premium per year (BPS)',
    'Extra rate added per year left to maturity',
    'maturity-premium-number'
  ],
  [
    'maturityPremium.maximumPremiumBps',
    'Premium cap (BPS)',
    'Optional ceiling on that extra rate',
    'maturity-premium-number'
  ],
  [
    'spreadBps',
    'Full spread (BPS)',
    'Gap between the two rungs closest to the centre; must be even',
    'number'
  ],
  ['stepBps', 'Step (BPS)', 'Gap between neighbouring rungs on the same side', 'number'],
  ['rungCount', 'Rungs per side', 'Rungs above and below the centre; 1 to 512', 'number'],
  [
    'sizeSkewBps',
    'Size skew (BPS)',
    'Each rung further out is weighted this many BPS more; negative favours inner rungs',
    'number'
  ],
  [
    'lowerRateBudgetAssets',
    'Reduce-only budget',
    'For offers below the centre, which reduce an existing position',
    'number'
  ],
  [
    'higherRateBudgetAssets',
    'Lending budget',
    'For offers above the centre, which lend new credit',
    'number'
  ],
  ['targetMarketExposureAssets', 'Market exposure cap', 'Caps lending in this market', 'number'],
  [
    'maximumTotalExposureAssets',
    'Total exposure cap',
    'Caps lending across every configured market together',
    'number'
  ],
  [
    'minimumOfferAssets',
    'Minimum offer size',
    'Every funded rung gets at least this; a budget too small drops outermost rungs',
    'number'
  ],
  [
    'groupMode',
    'Fill sharing',
    'shared-rung: capacity per rung. per-book: one capacity per side',
    'select'
  ],
  [
    'loopIntervalSeconds',
    'Check interval (seconds)',
    'How often to re-evaluate the ladder; 1 to 2147483',
    'number'
  ],
  [
    'movementToleranceBps',
    'Movement tolerance (BPS)',
    'Keep the current centre until the target centre moves further than this',
    'number'
  ],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Rungs never go below this', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Rungs never go above this', 'number']
] as const

const DEFAULT_MARKET_ID = `0x${'5'.repeat(64)}`

export const createDefaultBootstrap = (marketId = DEFAULT_MARKET_ID): BootstrapInput => ({
  marketId,
  targetRate: { strategy: 'variable_rate_avg' },
  creditTarget: '10000000000',
  acceptanceAssets: '100000000',
  offerSize: '500000000',
  premiumBps: '-50',
  maximumMarketExposure: '20000000000',
  maximumTotalExposure: '30000000000',
  minimumRateBps: '200',
  maximumRateBps: '800',
  autoRefill: true
})

export const createDefaultLadder = (marketId = DEFAULT_MARKET_ID): LadderInput => ({
  marketId,
  targetRate: { strategy: 'variable_rate_avg' },
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

const targetRateInput = (config: TargetRateConfigured<unknown>['targetRate']): TargetRateInput =>
  config.strategy === 'hardcoded'
    ? { strategy: 'hardcoded', hardcodedRateBps: String(config.hardcodedRateBps) }
    : { strategy: 'variable_rate_avg' }

const maturityPremiumInput = (config: MaturityPremiumConfig): MaturityPremiumInput => ({
  shape: config.shape,
  premiumPerYearBps: String(config.premiumPerYearBps),
  ...(config.maximumPremiumBps === undefined
    ? {}
    : { maximumPremiumBps: String(config.maximumPremiumBps) })
})

const bootstrapInput = (config: TargetRateConfigured<BootstrapConfig>): BootstrapInput => ({
  marketId: config.marketId,
  targetRate: targetRateInput(config.targetRate),
  creditTarget: String(config.creditTarget),
  acceptanceAssets: String(config.acceptanceAssets),
  offerSize: String(config.offerSize),
  premiumBps: String(config.premiumBps),
  ...(config.maturityPremium === undefined
    ? {}
    : { maturityPremium: maturityPremiumInput(config.maturityPremium) }),
  maximumMarketExposure: String(config.maximumMarketExposure),
  maximumTotalExposure: String(config.maximumTotalExposure),
  minimumRateBps: String(config.minimumRateBps),
  maximumRateBps: String(config.maximumRateBps),
  autoRefill: config.autoRefill
})

const ladderInput = (config: TargetRateConfigured<LadderConfig>): LadderInput => ({
  marketId: config.marketId,
  targetRate: targetRateInput(config.targetRate),
  quotePremiumBps: String(config.quotePremiumBps),
  ...(config.maturityPremium === undefined
    ? {}
    : { maturityPremium: maturityPremiumInput(config.maturityPremium) }),
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
  validation(() => parseBootstrap(items))
/**
 * Explains, in the operator's own units, why a ladder shape cannot fit its hard rate range.
 * @param items - Ordered ladder inputs as typed, which may not parse.
 * @returns One sentence per entry whose rungs span more than its configured range, naming the span
 * it needs and the width it has; empty when a shape fits or its integers are unusable.
 * @remarks Restates the runtime's own `sideWidth * 2 > maximumRateBps - minimumRateBps` invariant
 * so the sanitized parser message gains the arithmetic an operator needs to fix it.
 */
const ladderShapeDiagnostics = (items: LadderInput[]): string[] =>
  items.flatMap((item, index) => {
    const raw = [
      item.spreadBps,
      item.stepBps,
      item.rungCount,
      item.minimumRateBps,
      item.maximumRateBps
    ].map(value => value.trim())
    if (raw.some(value => !/^\d+$/.test(value))) return []
    const [spread, step, count, minimum, maximum] = raw.map(BigInt) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint
    ]
    if (count <= 0n || maximum < minimum) return []
    const span = (spread / 2n + (count - 1n) * step) * 2n
    const width = maximum - minimum
    if (span <= width) return []
    return [
      `Ladder ${index + 1}: ${count} rungs per side with a ${spread} BPS spread and a ${step} BPS step span ${span} BPS, but ${minimum}–${maximum} BPS is only ${width} BPS wide. Lower the rung count, the step or the spread, or widen the rate bounds.`
    ]
  })

export const validateLadderCollection = (items: LadderInput[]) => {
  const result = validation(() => parseLadder(items))
  if (result.valid) return result
  return { valid: false, errors: [...result.errors, ...ladderShapeDiagnostics(items)] }
}

export type BootstrapGraphicModel = {
  marketId: string
  referenceRateBps: string
  quotedRateBps: string
  /** Far-maturity end of the clamped quote range, present only with a maturity premium. */
  maximumQuotedRateBps?: string
  minimumRateBps: string
  maximumRateBps: string
  creditTarget: string
  acceptedCredit: string
  offerSize: string
  /** Reference range over which the quote tracks instead of saturating at a bound. */
  referenceBand?: ReferenceBand
  /** Present when a derived rate leaves the plotted range, explaining the pinned markers. */
  notice?: string
  callouts: { label: string; value: string; parameters: string[] }[]
}

/**
 * Derives a synthetic reference whose premium-adjusted quote is the integer midpoint of the bounds;
 * a maturity premium additionally renders the clamped quote range reachable across maturities.
 */
export const deriveBootstrapGraphicModels = (
  items: BootstrapInput[],
  formatAssets: AssetFormatter = rawAssetFormatter
): BootstrapGraphicModel[] =>
  parseBootstrap(items).map(item => {
    const minimum = BigInt(item.minimumRateBps)
    const maximum = BigInt(item.maximumRateBps)
    const premium = BigInt(item.premiumBps)
    const reference =
      item.targetRate.strategy === 'hardcoded'
        ? BigInt(item.targetRate.hardcodedRateBps)
        : (minimum + maximum) / 2n - premium
    const baseQuoted = reference + premium
    // With a maturity premium the runtime quote spans the reachable envelope (bounded by the cap
    // and the protocol's 100-year maturity horizon) before clamping, and the collection parser
    // already rejected rates pinned outside the bounds at every protocol-permitted maturity, so
    // the preview renders the clamped reachable range instead of validating the premium-free base.
    const quoted =
      item.maturityPremium === undefined ? baseQuoted : clampRateBps(baseQuoted, minimum, maximum)
    const maximumQuoted =
      item.maturityPremium === undefined
        ? undefined
        : clampRateBps(
            baseQuoted +
              highestReachableMaturityPremiumBps({
                shape: 'linear',
                premiumPerYearBps: BigInt(item.maturityPremium.premiumPerYearBps),
                ...(item.maturityPremium.maximumPremiumBps === undefined
                  ? {}
                  : { maximumPremiumBps: BigInt(item.maturityPremium.maximumPremiumBps) })
              }),
            minimum,
            maximum
          )
    const issues: string[] = []
    if (reference <= 0n) issues.push(`the derived reference ${reference} BPS is not positive`)
    else if (reference < minimum || reference > maximum) {
      issues.push(`the derived reference ${reference} BPS falls outside the plotted range`)
    }
    if (quoted < minimum || quoted > maximum) {
      issues.push(`the quote ${quoted} BPS would saturate at the nearest bound`)
    }
    const notice =
      issues.length === 0
        ? undefined
        : `Markers are pinned to the edge of the range: ${issues.join(' and ')}.${
            item.targetRate.strategy === 'hardcoded'
              ? ''
              : ' The preview derives its reference from the bounds and the premium, so this is an artefact of the preview, not an invalid configuration.'
          }`
    const acceptedCredit = BigInt(item.creditTarget) - BigInt(item.acceptanceAssets)
    const band = bootstrapReferenceBand(premium, minimum, maximum)
    return {
      marketId: item.marketId,
      referenceRateBps: String(reference),
      quotedRateBps: String(quoted),
      ...(maximumQuoted === undefined ? {} : { maximumQuotedRateBps: String(maximumQuoted) }),
      minimumRateBps: item.minimumRateBps,
      maximumRateBps: item.maximumRateBps,
      creditTarget: item.creditTarget,
      acceptedCredit: String(BigInt(item.creditTarget) - BigInt(item.acceptanceAssets)),
      offerSize: item.offerSize,
      ...(band === undefined ? {} : { referenceBand: band }),
      ...(notice === undefined ? {} : { notice }),
      callouts: [
        {
          label: 'Credit target',
          value: `Builds up to ${formatAssets(item.creditTarget)} of credit here, stopping once ${formatAssets(String(acceptedCredit))} is in place`,
          parameters: ['creditTarget', 'acceptanceAssets']
        },
        {
          label: 'Maximum offer size',
          value: `${formatAssets(item.offerSize)} per offer, also capped by the remaining target, the cash on hand and the two exposure caps. ${
            BigInt(item.offerSize) >= acceptedCredit
              ? 'One offer can fill the target'
              : `About ${(acceptedCredit + BigInt(item.offerSize) - 1n) / BigInt(item.offerSize)} offers to fill the target`
          }`,
          parameters: ['offerSize']
        },
        {
          label: 'Quote premium',
          value:
            band === undefined
              ? `Your quote is the market rate ${premium < 0n ? `minus ${-premium}` : `plus ${premium}`} BPS, which never lands inside ${item.minimumRateBps}–${item.maximumRateBps} BPS, so it always sticks at a limit`
              : `Your quote is the market rate ${premium < 0n ? `minus ${-premium}` : `plus ${premium}`} BPS, so it follows the market while that rate is ${band.lowestRateBps}–${band.highestRateBps} BPS and sticks at ${item.minimumRateBps} or ${item.maximumRateBps} BPS outside it`,
          parameters: ['premiumBps', 'minimumRateBps', 'maximumRateBps']
        },
        ...(item.maturityPremium
          ? [
              {
                label: 'Maturity premium',
                value: `Adds ${item.maturityPremium.premiumPerYearBps} BPS per year left to maturity${
                  item.maturityPremium.maximumPremiumBps === undefined
                    ? ''
                    : `, up to ${item.maturityPremium.maximumPremiumBps} BPS`
                }, shrinking as maturity approaches`,
                parameters: [
                  'maturityPremium.premiumPerYearBps',
                  'maturityPremium.maximumPremiumBps'
                ]
              }
            ]
          : []),
        {
          label: 'Exposure caps',
          value: `${formatAssets(item.maximumMarketExposure)} in this market, ${formatAssets(item.maximumTotalExposure)} across every configured market`,
          parameters: ['maximumMarketExposure', 'maximumTotalExposure']
        },
        {
          label: 'Auto-refill',
          value: item.autoRefill
            ? 'Lends again if the position later falls below target'
            : 'Stops for good once complete, even if the position later falls',
          parameters: ['autoRefill']
        },
        {
          label: 'Check interval',
          value:
            'Every 60 seconds, fixed for bootstrap. A resting offer is reposted on any size or rate change, and at least hourly even when nothing moves',
          parameters: []
        },
        {
          label: 'Failure handling',
          value:
            'One failed check stops monitoring, cancels this bot’s own offers, and exits. It does not retry',
          parameters: []
        },
        {
          label: 'Not shown here',
          value:
            'Live offers, balances, positions and the order book. This page reads no chain data, so nothing above reflects the current market',
          parameters: []
        }
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
  /** True far-maturity center at the highest reachable premium, only with a maturity premium. */
  maximumCenterRateBps?: string
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
  /** Reference range over which no rung pins to a hard bound. */
  referenceBand?: ReferenceBand
  /** Present when the derived reference leaves the plotted range, explaining the pinned marker. */
  notice?: string
  callouts: { label: string; value: string; parameters: string[] }[]
}

const collectionFromArgument = (value: LadderInput[] | PlaygroundState) =>
  Array.isArray(value) ? value : value.ladder

/**
 * Clamps a marker's plot coordinate into the rendered axis.
 * @param percent - Raw `rateToY` output for a marker whose true value may leave the axis range.
 * @returns The percentage bounded to the inclusive `[0, 100]` plot range.
 * @remarks Pure display geometry: model values stay true to runtime semantics (the ladder center
 * is never clamped at runtime), so only the rendered coordinate saturates at the plot edge.
 */
export const clampPlotPercent = (percent: number): number => Math.min(100, Math.max(0, percent))

/**
 * Generates each ladder preview around its deterministic reference, preserving rung/cap pairing
 * when displayed high-to-low.
 * @param value - Ordered ladder collection inputs, or a complete playground state whose ladder
 * list is previewed.
 * @returns One graphic model per entry: true center values (the at-maturity anchor and, with a
 * maturity premium, the far-maturity center at the highest reachable premium), display-ordered
 * rung rows with allocation and cap ratios, plot geometry, and callouts.
 * @throws `ConfigValidationError` from the shared collection parser when any entry is invalid. A
 * derived reference outside the configured bounds is not a failure: the preview is still generated
 * and carries a `notice` explaining that its markers are pinned to the edge.
 * @remarks Pure and browser-safe with no provider, logging, or persistence access. Center values
 * stay unclamped because the runtime clamps individual rungs, never the center; markers clamp
 * only their plot coordinate through {@link clampPlotPercent}.
 */
export const generateLadderGraphicModels = (
  value: LadderInput[] | PlaygroundState,
  formatAssets: AssetFormatter = rawAssetFormatter
): LadderGraphicModel[] =>
  parseLadder(collectionFromArgument(value)).map(input => {
    const config = ladderConfigsValue(
      [input],
      [parseBytes32(input.marketId, 'ladder[0].marketId')]
    )[0]!
    const minimum = config.minimumRateBps
    const maximum = config.maximumRateBps
    const reference =
      input.targetRate.strategy === 'hardcoded'
        ? BigInt(input.targetRate.hardcodedRateBps)
        : (minimum + maximum) / 2n - config.quotePremiumBps
    const notice =
      reference > 0n && reference >= minimum && reference <= maximum
        ? undefined
        : `Markers are pinned to the edge of the range: the derived reference ${reference} BPS falls outside it.${
            input.targetRate.strategy === 'hardcoded'
              ? ''
              : ' The preview derives its reference from the bounds and the premium, so this is an artefact of the preview, not an invalid configuration.'
          }`
    // The deterministic preview anchors the shape at the zero-premium (at-maturity) center. The
    // model carries true center values — the runtime clamps individual rungs, never the center —
    // and the component clamps only marker plot coordinates into the axis.
    const generated = generateLadder({
      config,
      referenceRateBps: reference,
      ...(config.maturityPremium === undefined ? {} : { secondsToMaturity: 0n })
    })
    const maximumCenter =
      config.maturityPremium === undefined
        ? undefined
        : generated.centerRateBps + highestReachableMaturityPremiumBps(config.maturityPremium)
    const amountOf = (rawAmount: bigint) => formatAssets(String(rawAmount))
    const referenceBand = ladderReferenceBand(config)
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
      ...(maximumCenter === undefined ? {} : { maximumCenterRateBps: String(maximumCenter) }),
      axis: {
        minimumRateBps: input.minimumRateBps,
        maximumRateBps: input.maximumRateBps,
        referenceRateBps: String(reference),
        centerRateBps: String(generated.centerRateBps)
      },
      gapBps: input.spreadBps,
      plotHeight,
      ...(referenceBand === undefined ? {} : { referenceBand }),
      ...(notice === undefined ? {} : { notice }),
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
          label: 'Quote premium',
          value: `Ladder centred on ${generated.centerRateBps} BPS: market rate ${reference} ${config.quotePremiumBps < 0n ? `minus ${-config.quotePremiumBps}` : `plus ${config.quotePremiumBps}`} BPS`,
          parameters: ['quotePremiumBps']
        },
        ...(config.maturityPremium
          ? [
              {
                label: 'Maturity premium',
                value: `Adds ${config.maturityPremium.premiumPerYearBps} BPS per year left to maturity${
                  config.maturityPremium.maximumPremiumBps === undefined
                    ? ''
                    : `, up to ${config.maturityPremium.maximumPremiumBps} BPS`
                }, shrinking as maturity approaches. The plot marks both ends of that travel`,
                parameters: [
                  'maturityPremium.premiumPerYearBps',
                  'maturityPremium.maximumPremiumBps'
                ]
              }
            ]
          : []),
        {
          label: 'Full spread and step',
          value: `${config.rungCount} rungs per side. The two rungs closest to the centre sit ${config.spreadBps} BPS apart, then each further rung steps out ${config.stepBps} BPS`,
          parameters: ['spreadBps', 'stepBps', 'rungCount']
        },
        {
          label: 'Size skew',
          value:
            config.sizeSkewBps === 0n
              ? 'Every rung on a side gets an equal share of that side’s budget'
              : `Each step out from the centre adds ${config.sizeSkewBps} BPS of weight, so the outermost rung is ${(BigInt(config.rungCount) - 1n) * (config.sizeSkewBps < 0n ? -config.sizeSkewBps : config.sizeSkewBps)} BPS ${config.sizeSkewBps > 0n ? 'heavier' : 'lighter'} than the innermost`,
          parameters: ['sizeSkewBps']
        },
        {
          label: 'Budgets',
          value: `Lends up to ${amountOf(config.higherRateBudgetAssets)} above the centre, and offers up to ${amountOf(config.lowerRateBudgetAssets)} below it to reduce an existing position`,
          parameters: ['higherRateBudgetAssets', 'lowerRateBudgetAssets']
        },
        {
          label: 'Minimum offer size',
          value: `Every funded rung gets at least ${amountOf(config.minimumOfferAssets)}; when a side cannot cover them all its outermost rungs are dropped. Your budgets cover ${config.higherRateBudgetAssets / config.minimumOfferAssets} lending and ${config.lowerRateBudgetAssets / config.minimumOfferAssets} reduce-only rungs, against the ${config.rungCount} configured`,
          parameters: ['minimumOfferAssets', 'higherRateBudgetAssets', 'lowerRateBudgetAssets']
        },
        {
          label: 'Exposure caps',
          value: `Cap the lending side only: ${amountOf(config.targetMarketExposureAssets)} in this market and ${amountOf(config.maximumTotalExposureAssets)} across every configured market, whichever binds first. Reduce-only offers are not capped by either`,
          parameters: ['targetMarketExposureAssets', 'maximumTotalExposureAssets']
        },
        {
          label: 'Minimum and maximum rate',
          value:
            referenceBand === undefined
              ? `Rungs never cross ${input.minimumRateBps} or ${input.maximumRateBps} BPS, and some rung always sits on a limit whatever the market does`
              : referenceBand.lowestRateBps === referenceBand.highestRateBps
                ? `Rungs never cross ${input.minimumRateBps} or ${input.maximumRateBps} BPS. The full ladder fits only at a market rate of exactly ${referenceBand.lowestRateBps} BPS; any move squashes rungs onto a limit`
                : `Rungs never cross ${input.minimumRateBps} or ${input.maximumRateBps} BPS. The full ladder fits while the market rate is ${referenceBand.lowestRateBps}–${referenceBand.highestRateBps} BPS; outside that, rungs squash onto a limit`,
          parameters: ['minimumRateBps', 'maximumRateBps']
        },
        {
          label: 'Fill sharing',
          value:
            config.groupMode === 'shared-rung'
              ? 'Each rung has its own capacity, so a fill at one rate leaves every other rate untouched'
              : 'All rungs on a side share one capacity, so a fill at any rate reduces what every other rate on that side can take',
          parameters: ['groupMode']
        },
        {
          label: 'Check interval',
          value: `Every ${config.loopIntervalSeconds} seconds. While the target centre stays within ${config.movementToleranceBps} BPS the ladder holds its current centre and only resizes; a bigger move recentres every rung`,
          parameters: ['loopIntervalSeconds', 'movementToleranceBps']
        },
        {
          label: 'Not shown here',
          value:
            'Live offers, balances, positions and the order book. This page reads no chain data, so nothing above reflects the current market',
          parameters: []
        }
      ]
    }
  })

const MAXIMUM_COLLECTION_JSON_BYTES = 128 * 1024
const MAXIMUM_JSON_NESTING = 128
const scannerSyntax = Symbol('scannerSyntax')

/** Detects duplicate object names before JSON.parse can overwrite them. */
const assertNoDuplicateJsonMembers = (text: string) => {
  let position = 0
  const syntax = (): never => {
    throw scannerSyntax
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
        let decoded: string
        try {
          decoded = JSON.parse(encoded) as string
        } catch {
          return syntax()
        }
        for (let index = 0; index < decoded.length; index++) {
          const code = decoded.charCodeAt(index)
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(index + 1)
            if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
              throw new StrictJsonError('Import contains an invalid Unicode surrogate')
            index++
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new StrictJsonError('Import contains an invalid Unicode surrogate')
          }
        }
        return decoded
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
        if (['__proto__', 'constructor', 'prototype'].includes(name))
          throw new StrictJsonError('Import contains an unsafe JSON member name')
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
    if (token === undefined) throw scannerSyntax
    position += token.length
  }
  try {
    value(0)
    whitespace()
    if (position !== text.length) syntax()
  } catch (error) {
    if (error !== scannerSyntax) throw error
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
    throw new StrictJsonError('Import must be valid JSON')
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  createError: (message: string) => Error = message => new CollectionImportError(message)
) => {
  const unsupported = Object.keys(record).find(key => !allowed.includes(key))
  if (unsupported) throw createError('Object contains an unsupported key')
}
const itemKind = (value: unknown): 'bootstrap' | 'ladder' => {
  if (!plainObject(value))
    throw new CollectionImportError('Import item must be a supported collection object')
  const keys = Object.keys(value)
  const bootstrap =
    keys.every(key => BOOTSTRAP_MARKET_FIELDS.includes(key as never)) && keys.includes('autoRefill')
  const ladder =
    keys.every(key => LADDER_MARKET_FIELDS.includes(key as never)) && keys.includes('groupMode')
  if (bootstrap === ladder)
    throw new CollectionImportError('Import item is not a supported exact collection object')
  return bootstrap ? 'bootstrap' : 'ladder'
}

export type CollectionsImport = Partial<Pick<PlaygroundState, 'bootstrap' | 'ladder'>>
export const parseCollectionsImport = (text: string): CollectionsImport => {
  let parsed = parseJson(text)
  if (typeof parsed === 'string') parsed = parseJson(parsed)
  if (typeof parsed === 'string')
    throw new CollectionImportError('Import accepts at most one JSON string layer')
  if (Array.isArray(parsed)) {
    if (parsed.length === 0)
      throw new CollectionImportError('Empty array is not a supported unlabelled import')
    const kinds = parsed.map(itemKind)
    if (new Set(kinds).size !== 1)
      throw new CollectionImportError('Import cannot contain mixed collection item types')
    return kinds[0] === 'bootstrap'
      ? { bootstrap: parseBootstrap(parsed) }
      : { ladder: parseLadder(parsed) }
  }
  if (!plainObject(parsed))
    throw new CollectionImportError('Import must use a supported collection shape')
  const keys = Object.keys(parsed)
  if (keys.includes('bootstrap') || keys.includes('ladder')) {
    exactKeys(parsed, ['bootstrap', 'ladder'])
    if (keys.length === 0)
      throw new CollectionImportError('Import must contain a supported collection')
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
type PlaygroundLocation = {
  origin: string
  pathname: string
  search: string
}

export const encodePlaygroundFragment = (state: PlaygroundState) => {
  const validation = validatePlaygroundState(state)
  if (!validation.valid) throw new FragmentCodecError('Fragment state is invalid')
  const canonical = {
    version: COLLECTION_FRAGMENT_VERSION,
    bootstrap: parseBootstrap(state.bootstrap),
    ladder: parseLadder(state.ladder)
  }
  const encoded = encodeURIComponent(JSON.stringify(canonical))
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_COLLECTION_JSON_BYTES) {
    throw new FragmentCodecError('Fragment exceeds the 128 KiB size limit')
  }
  return `#${encoded}`
}

/**
 * Builds the canonical share URL for a runtime-valid playground state.
 *
 * @param state - Current TanStack form values to encode.
 * @param location - Current document origin, path, and query components.
 * @returns A canonical absolute URL containing the exact encoded playground fragment.
 * @throws When either collection is runtime-invalid or the encoded fragment exceeds its size bound.
 */
export const createPlaygroundShareUrl = (state: PlaygroundState, location: PlaygroundLocation) =>
  `${location.origin}${location.pathname}${location.search}${encodePlaygroundFragment(state)}`

export const decodePlaygroundFragment = (fragment: string): PlaygroundState => {
  const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (encoded === '') return createDefaultPlaygroundState()
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_COLLECTION_JSON_BYTES) {
    throw new FragmentCodecError('Fragment exceeds the 128 KiB size limit')
  }
  let text: string
  try {
    text = decodeURIComponent(encoded)
  } catch {
    throw new FragmentCodecError('Fragment must be valid percent-encoded JSON')
  }
  const parsed = parseJson(text)
  if (!plainObject(parsed)) throw new FragmentCodecError('Fragment payload must be an object')
  exactKeys(parsed, ['version', 'bootstrap', 'ladder'], message => new FragmentCodecError(message))
  if (Object.keys(parsed).length !== 3)
    throw new FragmentCodecError('Fragment payload is missing a required key')
  if (parsed.version !== COLLECTION_FRAGMENT_VERSION)
    throw new FragmentCodecError('Unsupported fragment version')
  const state = { bootstrap: parseBootstrap(parsed.bootstrap), ladder: parseLadder(parsed.ladder) }
  const validation = validatePlaygroundState(state)
  if (!validation.valid) throw new FragmentCodecError('Fragment state is invalid')
  return state
}

const assertValid = <T>(items: T[], validate: (items: T[]) => CollectionValidation) => {
  const result = validate(items)
  if (!result.valid) throw new CollectionValidationError('Collection is invalid')
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
