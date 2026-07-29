/**
 * Serializes one suppressed make operation for terminal output.
 * @param workflow - Strategy workflow that requested the mutation.
 * @param operation - Reconciliation or strategy-wide halt request.
 * @param request - Domain request that would have reached a live mutation adapter.
 * @returns One compact JSON line with exact bigint values encoded as decimal strings.
 * @throws `TypeError` when an unexpected cyclic request cannot be serialized.
 * @remarks Pure formatting; no signing, provider, terminal, or mutation side effects occur.
 */
export const formatReadOnlyMakeEvent = (
  workflow: 'bootstrap' | 'ladder',
  operation: 'reconcile' | 'hard-halt',
  request: unknown
) =>
  JSON.stringify({ event: 'readonly.make', workflow, operation, request }, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  )
