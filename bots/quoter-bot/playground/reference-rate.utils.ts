/**
 * Reference rate the preview panel starts from.
 * @remarks Empty on purpose, and never a guess at a plausible market rate: the playground reads no
 * chain data and cannot observe the reference market, so until an operator supplies a rate every
 * `variable_rate_avg` preview keeps deriving its own synthetic reference from the configured
 * bounds and premium.
 */
export const DEFAULT_REFERENCE_RATE_BPS = ''

/**
 * Resolves the reference rate typed into the preview panel.
 * @param value - Raw text held by the panel input.
 * @returns The positive reference rate in BPS, or `undefined` when the entry is empty or unusable.
 * @remarks Zero is unusable, not a rate: the runtime's reference read throws on a non-positive
 * rate before it ever quotes, so previewing one would show a quote no reference can produce.
 * Display-side only otherwise: the entry feeds the previews and never reaches the four collection
 * outputs, the share URL, or the fragment, because the reference market is runtime scalar setup
 * (`REFERENCE_MARKET_ID`) rather than part of an ordered market collection. An unresolved entry
 * always means the derived synthetic reference, never an assumed market rate.
 */
/**
 * Resolves the face credit typed into the preview panel for skewed ladders.
 * @param value - Raw text held by the panel input.
 * @returns The non-negative raw face credit, or `undefined` when the entry is empty or unusable.
 * @remarks Preview only, like the reference rate: it prices an `inventorySkew` preview and its
 * reference band, and never reaches the outputs, the share URL or the fragment.
 */
export const resolveCreditHeldAssets = (value: string): bigint | undefined => {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : undefined
}

export const resolveReferenceRateBps = (value: string): bigint | undefined => {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const rateBps = BigInt(trimmed)
  return rateBps > 0n ? rateBps : undefined
}
