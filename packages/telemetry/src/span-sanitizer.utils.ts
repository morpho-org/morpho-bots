import type { SpanProcessor } from '@opentelemetry/sdk-trace-node'

type EndedSpan = Parameters<SpanProcessor['onEnd']>[0]

const sanitizeEndedSpan = (span: EndedSpan) => {
  const events = span.events as { name: string }[]
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.name === 'exception') events.splice(index, 1)
  }
  if (span.status.message !== undefined) {
    ;(span as { status: EndedSpan['status'] }).status = { code: span.status.code }
  }
}

/**
 * Wraps a span processor so no free-form error text can reach the exporter.
 * @param processor - Exporting processor receiving only sanitized spans.
 * @returns A processor dropping every `exception` event and every status message on span end.
 * @remarks Instrumentations record failures verbatim — undici, for example, attaches
 * `exception.message`/`exception.stacktrace` events and puts `error.message` into the span
 * status — and provider errors can embed credentialed URLs and response bodies. Failure identity
 * survives as the error status code plus low-cardinality attributes (`errorName`, `error.type`);
 * the sanitized spans are mutated in place before delegation, so nothing unsanitized is buffered.
 */
export const withSpanSanitizer = (processor: SpanProcessor): SpanProcessor => ({
  forceFlush: () => processor.forceFlush(),
  onStart: (span, parentContext) => processor.onStart(span, parentContext),
  onEnd: span => {
    sanitizeEndedSpan(span)
    processor.onEnd(span)
  },
  shutdown: () => processor.shutdown()
})
