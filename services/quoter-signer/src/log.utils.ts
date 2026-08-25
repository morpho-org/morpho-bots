/**
 * Writes one structured record to stdout as a single JSON line, bigint-safe (decimal strings).
 *
 * Local helper by design: `@repo/logging`'s `createCliLogger` is an operator-CLI presenter
 * (stdout results vs stderr errors, human mode) and `@repo/bot-kit`'s logger carries loglayer and
 * log-shipping dependencies — both mismatch a Lambda handler whose only sink is CloudWatch Logs
 * and whose image must stay minimal (TIB-2026-08-12 treats the middleware as the root of trust).
 * @param record - Record built exclusively from middleware-owned values, never caller data.
 */
export const emitJsonLine = (record: Record<string, unknown>): void => {
  console.log(
    JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  )
}
