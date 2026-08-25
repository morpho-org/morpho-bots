import type { MaturityPremiumInput, TargetRateInput } from './model'

export type FieldDefinition = readonly [string, string, string, string]

/** Slope preselected when an editor enables the linear maturity premium, in BPS per year. */
export const DEFAULT_MATURITY_PREMIUM_PER_YEAR_BPS = '100'

/**
 * Filters an editor's field definitions down to the rows valid for one market item.
 * @param fields - Complete ordered field definitions for the collection kind.
 * @param targetRate - The item's target-rate selection controlling the hardcoded-rate row.
 * @param maturityPremium - The item's maturity-premium selection; only bootstrap items supply it.
 * @returns The fields to render: the hardcoded-rate row only for the `hardcoded` strategy, the
 * maturity-premium shape row always, and its detail rows only while a premium is selected.
 */
export const visibleFields = (
  fields: readonly FieldDefinition[],
  targetRate: TargetRateInput,
  maturityPremium?: MaturityPremiumInput
): readonly FieldDefinition[] =>
  fields.filter(
    ([key]) =>
      (key !== 'targetRate.hardcodedRateBps' || targetRate.strategy === 'hardcoded') &&
      (!key.startsWith('maturityPremium.') ||
        key === 'maturityPremium.shape' ||
        maturityPremium !== undefined)
  )

/**
 * Derives the maturity-premium value for a shape-select change.
 * @param current - The item's current maturity-premium selection, when one exists.
 * @param selected - The chosen select option: `linear` enables the premium, anything else clears it.
 * @returns The current selection unchanged when `linear` is re-selected, a fresh linear premium at
 * the default slope when enabling, or `undefined` when the premium is disabled.
 */
export const maturityPremiumSelection = (
  current: MaturityPremiumInput | undefined,
  selected: string
): MaturityPremiumInput | undefined =>
  selected === 'linear'
    ? (current ?? { shape: 'linear', premiumPerYearBps: DEFAULT_MATURITY_PREMIUM_PER_YEAR_BPS })
    : undefined

/**
 * Removes the optional maturity-premium cap so an emptied input exports without the key.
 * @param current - The item's current maturity-premium selection, when one exists.
 * @returns The selection without `maximumPremiumBps`, or `undefined` when none exists.
 */
export const withoutMaximumPremium = (
  current: MaturityPremiumInput | undefined
): MaturityPremiumInput | undefined =>
  current === undefined
    ? undefined
    : { shape: current.shape, premiumPerYearBps: current.premiumPerYearBps }
