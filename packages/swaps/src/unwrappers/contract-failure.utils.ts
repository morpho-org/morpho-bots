// Revert with decodable data / revert without data (how viem surfaces "plain ERC20 has no
// asset()") / a successful call that returned no data (address without code).
const CONTRACT_LEVEL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ContractFunctionRevertedError',
  'ExecutionRevertedError',
  'ContractFunctionZeroDataError'
])

// Cheap insurance against a self-referential `cause` (a malformed third-party error): the real
// chains are 4-6 links deep, so a bound this loose never truncates a genuine one.
const MAX_CAUSE_DEPTH = 32

/**
 * `true` only for a failure the CONTRACT produced (revert, no code / empty return): the one kind of
 * `readContract` error that proves "this token is not an ERC4626 vault" and is safe to memoize.
 * Transport-layer failures (HTTP, timeout, RPC) must NOT be classified here — memoizing one would
 * mislabel a real vault for the process lifetime, so callers rethrow them instead (→ the existing
 * `failed` outcome + backoff, which recovers).
 *
 * Matches on `name` down the `cause` chain rather than `instanceof` against viem's error classes.
 * The clients these errors come from are built in another workspace package, so an `instanceof`
 * here compares against whichever viem copy THIS package resolved; when a dependency split gives
 * them different copies, every such check silently returns false and a plain ERC20 is rethrown as
 * an infrastructure failure — the 2026-08-12 staging incident, where the midnight liquidator never
 * liquidated a post-maturity position. `test/viem-dedupe.test.ts` keeps the copies deduped; this
 * keeps the classification correct even if one slips through.
 *
 * @param error - Anything thrown by a viem contract read; non-`Error` values are not contract-level.
 * @returns Whether the chain contains a contract-produced failure.
 */
export const isContractLevelFailure = (error: unknown): boolean => {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (CONTRACT_LEVEL_ERROR_NAMES.has(current.name)) return true
    current = current.cause
  }
  return false
}
