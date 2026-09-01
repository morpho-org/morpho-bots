/**
 * Decimals the display-units panel starts from.
 * @remarks A convenience default, not derived data: the playground reads no chain data and cannot
 * resolve the configured `loanAsset`, but that asset is USDC in practice, so the panel starts at
 * its 6 decimals. Correct it for any other loan asset; clearing the entry returns every amount to
 * its exact raw integer.
 */
export const DEFAULT_ASSET_DECIMALS = '6'
/** Inclusive upper bound accepted for the display-decimals entry. */
export const MAXIMUM_ASSET_DECIMALS = 36

/**
 * Formats one raw integer amount as a whole-token-unit amount for reading.
 * @param rawAmount - Raw unsigned integer asset or credit amount as configured.
 * @param decimals - Non-negative token decimals applied as the fixed-point scale.
 * @returns A grouped whole-unit amount, `<1` for a non-zero amount below one unit, or the input
 * when it is not an integer.
 * @remarks Deliberately lossy: fractional units are rounded away because the rendering exists only
 * to make magnitudes scannable and never feeds configuration. The exact raw integer stays in the
 * editors, the four collection outputs, the share URL, and each amount's hover title.
 */
export const formatAssetAmount = (rawAmount: string, decimals: number): string => {
  if (!/^-?\d+$/.test(rawAmount) || !Number.isInteger(decimals) || decimals < 0) return rawAmount
  const negative = rawAmount.startsWith('-')
  const value = BigInt(negative ? rawAmount.slice(1) : rawAmount)
  const scale = 10n ** BigInt(decimals)
  const whole = (value + scale / 2n) / scale
  const sign = negative ? '-' : ''
  if (whole === 0n && value > 0n) return `${sign}<1`
  return `${sign}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

/**
 * Resolves the decimals entry typed into the display-units panel.
 * @param value - Raw text held by the panel input.
 * @returns The bounded non-negative decimals, or `undefined` when the entry is empty or unusable.
 * @remarks An unresolved entry always means raw amounts, never an assumed scale.
 */
export const resolveDecimals = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const decimals = Number(trimmed)
  return decimals > MAXIMUM_ASSET_DECIMALS ? undefined : decimals
}

/**
 * Builds the display formatter applied to every raw amount rendered in the previews.
 * @param decimals - Current display-units panel entry for the configured loan asset.
 * @returns A formatter rendering every amount in whole token units, leaving amounts raw while no
 * usable entry exists so the panel can never fabricate a misleading amount.
 * @remarks One scale covers both collections: a quoter-bot process has exactly one
 * `LOAN_ASSET_ADDRESS`, and every configured amount — credit targets, offer sizes, budgets, and
 * exposure caps in both collections — is a raw smallest-unit amount of that single loan asset.
 * Collateral tokens never appear in an ordered market collection.
 */
export const assetFormatter = (decimals: string) => {
  const resolved = resolveDecimals(decimals)
  return (rawAmount: string): string =>
    resolved === undefined ? rawAmount : formatAssetAmount(rawAmount, resolved)
}
