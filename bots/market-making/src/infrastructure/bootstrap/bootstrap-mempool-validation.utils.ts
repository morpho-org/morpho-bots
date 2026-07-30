import { MempoolPayloadValidationRule } from '@morpho-org/midnight-sdk/api'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
import {
  BootstrapMempoolValidationError,
  type BootstrapMempoolValidationIssue
} from './bootstrap-mempool-validation.error'

const knownRules = new Set<string>(Object.values(MempoolPayloadValidationRule))

const validationIssues = (error: unknown): BootstrapMempoolValidationIssue[] | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as Record<string, unknown>
  if (candidate.name !== 'MidnightMempoolValidationError' || !Array.isArray(candidate.issues)) {
    return undefined
  }

  return candidate.issues.map(value => {
    if (typeof value !== 'object' || value === null) return { rule: 'unknown' }
    const issue = value as Record<string, unknown>
    const rule =
      typeof issue.rule === 'string' && knownRules.has(issue.rule) ? issue.rule : 'unknown'
    if (rule !== MempoolPayloadValidationRule.MinOfferAssetsUsd) return { rule }

    const details =
      typeof issue.details === 'object' && issue.details !== null
        ? (issue.details as Record<string, unknown>)
        : undefined
    const minimumAssets =
      details?.type === 'minOfferAssetsUsd' &&
      typeof details.minAssets === 'bigint' &&
      details.minAssets >= 0n
        ? details.minAssets
        : undefined
    return { rule, ...(minimumAssets === undefined ? {} : { minimumAssets }) }
  })
}

/**
 * Runs the SDK's Mempool-policy validation and translates every expected rejection.
 * @param validate - Deferred SDK preparation that performs remote Mempool validation.
 * @returns The unchanged prepared SDK output after policy validation succeeds.
 * @throws `BootstrapMempoolValidationError` for sanitized policy issues, or
 * `BootstrapAdapterError` for every other SDK/provider validation failure.
 * @remarks This boundary neither signs nor broadcasts a transaction.
 */
export const validateBootstrapMempoolPublication = async <Result>(
  validate: () => Promise<Result>
): Promise<Result> => {
  try {
    return await validate()
  } catch (error) {
    if (
      error instanceof BootstrapMempoolValidationError ||
      error instanceof BootstrapAdapterError
    ) {
      throw error
    }
    const issues = validationIssues(error)
    if (issues) throw new BootstrapMempoolValidationError(issues)
    throw new BootstrapAdapterError('mempool-validation')
  }
}
