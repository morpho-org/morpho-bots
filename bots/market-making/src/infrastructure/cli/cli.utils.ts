import type { SetupCheckReport } from '../../application/setup/setup-check.service'

/**
 * Serializes a sanitized setup report for the CLI, converting bigint values to decimal strings.
 * @param report - Complete setup report containing no raw provider URLs or secrets.
 * @returns Compact JSON suitable for standard output or error output.
 * @throws When an unexpected cyclic value prevents JSON serialization.
 * @remarks Pure formatting only; no provider, filesystem, or chain side effects occur.
 */
export const formatSetupCheckReport = (report: SetupCheckReport) =>
  JSON.stringify(report, (_, item) => (typeof item === 'bigint' ? item.toString() : item))
