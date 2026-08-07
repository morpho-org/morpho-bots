import type { TargetRateInput } from './model'

export type FieldDefinition = readonly [string, string, string, string]

export const visibleFields = (
  fields: readonly FieldDefinition[],
  targetRate: TargetRateInput
): readonly FieldDefinition[] =>
  fields.filter(
    ([key]) => key !== 'targetRate.hardcodedRateBps' || targetRate.strategy === 'hardcoded'
  )
