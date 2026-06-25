// Byte-for-byte TS port of Midnight's `TickLib` (docs/context/repos/midnight-contracts.txt:552-618).
// Used only by the position-seeding operator script to turn a target offer price into a valid tick.
// bigint `/` truncates toward zero exactly like Solidity integer division, and the sign handling in
// `wExp` is reproduced directly, so these match the contract bit-for-bit. The seeding script also
// asserts `priceToTick(tickToPrice(t)) === t` at runtime as a self-check before any transaction.

const WAD = 10n ** 18n
const ONE_E36 = 10n ** 36n

// `0.004987541511039073e18` — floor(ln(1.005) * 1e18).
const LN_ONE_PLUS_DELTA = 4987541511039073n
// floor(ln(2) * 1e18) and the wExp offset `0.32261121498945987e18`.
const LN2 = 693147180559945309n
const WEXP_OFFSET = 322611214989459870n
// Minimum representable price increment in WAD (1e-6 WAD); tick prices round to multiples of it.
const PRICE_ROUNDING_STEP = 10n ** 12n

const MAX_TICK = 5820n
export const DEFAULT_TICK_SPACING = 4n

/** `x / d` rounded to nearest, ties down (TickLib.divHalfDownUnchecked, :566-570). */
function divHalfDownUnchecked(x: bigint, d: bigint) {
  return (x + (d - 1n) / 2n) / d
}

/** Fixed-point `e^(x / 1e18) * 1e18` (TickLib.wExp, :572-591). */
function wExp(x: bigint): bigint {
  if (x < 0n) return ONE_E36 / wExp(-x)
  const q = (x + WEXP_OFFSET) / LN2
  const r = x - q * LN2
  const secondTerm = (r * r) / (2n * WAD)
  const thirdTerm = (secondTerm * r) / (3n * WAD)
  const expR = WAD + r + secondTerm + thirdTerm
  return expR << q
}

/** Price (WAD) of a tick (TickLib.tickToPrice, :593-601). Reverts if `tick > MAX_TICK`. */
export function tickToPrice(tick: bigint) {
  if (tick > MAX_TICK) throw new Error(`tick ${tick} out of range (max ${MAX_TICK})`)
  const denom = WAD + wExp(LN_ONE_PLUS_DELTA * (MAX_TICK / 2n - tick))
  return (
    divHalfDownUnchecked(divHalfDownUnchecked(ONE_E36, denom), PRICE_ROUNDING_STEP) *
    PRICE_ROUNDING_STEP
  )
}

/** Lowest tick that is a multiple of `spacing` whose price ≥ `price` (TickLib.priceToTick, :605-616). */
export function priceToTick(price: bigint, spacing = DEFAULT_TICK_SPACING) {
  if (price > WAD) throw new Error(`price ${price} exceeds 1 WAD`)
  let low = 0n
  let high = MAX_TICK
  while (low !== high) {
    const mid = (low + high) / 2n
    if (tickToPrice(mid) < price) low = mid + 1n
    else high = mid
  }
  return ((low + spacing - 1n) / spacing) * spacing
}
