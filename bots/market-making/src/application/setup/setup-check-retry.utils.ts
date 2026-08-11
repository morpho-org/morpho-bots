import type { SetupCheck, SetupCheckReport } from './setup-check.service'

/** Consecutive retry-safe timeout reports allowed before setup monitoring halts. */
export const CONSECUTIVE_REQUEST_TIMEOUT_LIMIT = 3

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRequestTimeout = (value: unknown) =>
  isRecord(value) && value.kind === 'provider-error' && value.code === 'REQUEST_TIMEOUT'

const hasOnlyRequestTimeoutErrors = (observed: Record<string, unknown>) => {
  if (Array.isArray(observed.errors)) {
    return observed.errors.length > 0 && observed.errors.every(isRequestTimeout)
  }
  return isRequestTimeout(observed.error)
}

const hasUnsafeRatifierEvidence = (observed: Record<string, unknown>) =>
  observed.type === undefined ||
  ['listed', 'deployed', 'midnightMatches', 'surfaceMatches', 'authorized'].some(
    key => observed[key] === false
  )

const hasUnsafeOfferEvidence = (observed: Record<string, unknown>) =>
  ['unknownNamespaces', 'unknownMarketIds', 'invertedMarketIds'].some(
    key => Array.isArray(observed[key]) && observed[key].length > 0
  )

const isRequestTimeoutCheck = (check: SetupCheck) => {
  if (check.name === 'chain' || check.name === 'books' || check.name === 'reference') return false
  if (!isRecord(check.observed) || !hasOnlyRequestTimeoutErrors(check.observed)) return false

  if (check.name === 'ratifier') return !hasUnsafeRatifierEvidence(check.observed)
  if (check.name === 'offers') return !hasUnsafeOfferEvidence(check.observed)
  return true
}

/**
 * Identifies a failed readiness report caused exclusively by retry-safe provider request deadlines.
 * @param report - Complete sanitized setup report emitted by one monitoring cycle.
 * @returns Whether every failed check contains only `REQUEST_TIMEOUT` evidence and no known unsafe sibling fact.
 * @remarks Chain, books, and reference remain lossy aggregates and fail immediately. Ratifier and offer
 * observations preserve partial safe/unsafe evidence, so timeout-only reports can use the retry budget while
 * any explicit unsafe sibling fact or unsupported ratifier type fails closed on the first cycle.
 */
export const hasOnlyRequestTimeoutFailures = (report: SetupCheckReport) => {
  const failedChecks = report.checks.filter(check => check.status === 'failed')
  return failedChecks.length > 0 && failedChecks.every(isRequestTimeoutCheck)
}
