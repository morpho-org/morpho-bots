import { InvalidConfigurationError } from './invalid-configuration.error'

/**
 * Parses the fail-closed readonly mode switch.
 * @param value - Raw `READONLY` environment value.
 * @returns `true` for `true`/`1`; `false` for absent, empty, `false`, or `0` values.
 * @throws `InvalidConfigurationError` for every other nonempty value.
 * @remarks Parsing is case-insensitive and performs no side effects.
 */
export const parseReadonly = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase() || ''
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === '' || normalized === 'false' || normalized === '0') return false
  throw new InvalidConfigurationError('READONLY must be one of: true, 1, false, 0')
}
