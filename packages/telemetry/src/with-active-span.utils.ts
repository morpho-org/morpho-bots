import type { Attributes } from '@opentelemetry/api'

import { SpanStatusCode, trace } from '@opentelemetry/api'

const TRACER_NAME = '@repo/telemetry'

/**
 * Runs one operation inside an active named span so nested outbound requests join its trace.
 * @param options - Span name, low-cardinality attributes, an optional sanitized error-name
 * projection recorded on failure, and an optional handled-failure predicate over the result.
 * @param operation - Operation to execute within the span's context.
 * @returns The operation's result, rethrowing its failure unchanged.
 * @throws Whatever the operation throws; span bookkeeping never adds or replaces failures.
 * @remarks With no telemetry pipeline registered this is a no-op wrapper. On failure only the
 * span status flips to error, plus the injected `errorName` projection when one is provided —
 * raw error messages are never recorded on spans because provider errors can embed credentialed
 * URLs and response bodies. `failed` marks the same error status for handled failures the
 * operation returns instead of throwing; a throwing predicate is ignored rather than allowed to
 * replace the result.
 */
export const withActiveSpan = <Result>(
  options: {
    name: string
    attributes?: Attributes
    errorName?: (error: unknown) => string
    failed?: (result: Result) => boolean
  },
  operation: () => Promise<Result>
): Promise<Result> =>
  trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(options.name, { attributes: options.attributes }, async span => {
      try {
        const result = await operation()
        try {
          if (options.failed?.(result) === true) span.setStatus({ code: SpanStatusCode.ERROR })
        } catch {
          // A status predicate must never add or replace failures.
        }
        return result
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        if (options.errorName) span.setAttribute('errorName', options.errorName(error))
        throw error
      } finally {
        span.end()
      }
    })
