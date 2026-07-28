import type { SetupCheckReport } from '../../application/setup-check.service'

/**
 * Serializes a sanitized CLI result, converting bigint values to decimal strings.
 * @param result - Sanitized application result intended for standard output.
 * @returns Compact JSON suitable for standard output.
 * @throws When an unexpected cyclic value prevents JSON serialization.
 * @remarks Pure formatting only; no provider, filesystem, or chain side effects occur.
 */
export const formatCliResult = (result: unknown) =>
  JSON.stringify(result, (_, item) => (typeof item === 'bigint' ? item.toString() : item))

/**
 * Serializes a sanitized setup report for the CLI, converting bigint values to decimal strings.
 * @param report - Complete setup report containing no raw provider URLs or secrets.
 * @returns Compact JSON suitable for standard output or error output.
 * @throws When an unexpected cyclic value prevents JSON serialization.
 * @remarks Pure formatting only; no provider, filesystem, or chain side effects occur.
 */
export const formatSetupCheckReport = (report: SetupCheckReport) => formatCliResult(report)
