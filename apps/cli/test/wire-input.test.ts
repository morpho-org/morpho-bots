import type { Logger } from '@repo/bot-kit'

import { describe, expect, it } from 'bun:test'

import { consumeRecordBatches } from '../src/wire-input'

function loggerWithWarnings() {
  const warnings: Record<string, unknown>[] = []
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_event, fields) => warnings.push(fields ?? {}),
    error: () => undefined
  }
  return { logger, warnings }
}

function stream(...chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

describe('consumeRecordBatches', () => {
  it('streams additive JSON values in bounded batches across chunk boundaries', async () => {
    const { logger } = loggerWithWarnings()
    const batches: unknown[][] = []
    const summary = await consumeRecordBatches(
      stream('{"kind":"position","extra":1}\n[1', ',2]\n"opaque"'),
      logger,
      async records => void batches.push([...records]),
      { batchSize: 2 }
    )

    expect(batches).toEqual([[{ kind: 'position', extra: 1 }, [1, 2]], ['opaque']])
    expect(summary).toEqual({ invalidLines: 0, records: 3 })
  })

  it('reports malformed input after delivering every valid record', async () => {
    const { logger, warnings } = loggerWithWarnings()
    const records: unknown[] = []
    const summary = await consumeRecordBatches(
      stream('{"id":"first"}\n{bad\n\n{"id":"next"}'),
      logger,
      async batch => void records.push(...batch)
    )

    expect(records).toEqual([{ id: 'first' }, { id: 'next' }])
    expect(summary).toEqual({ invalidLines: 1, records: 2 })
    expect(warnings).toEqual([{ reason: 'malformed_line' }])
  })

  it('bounds an incomplete or complete line and continues at the next newline', async () => {
    const { logger, warnings } = loggerWithWarnings()
    const records: unknown[] = []
    const summary = await consumeRecordBatches(
      stream('123456', '789012\n{"ok":true}\n123456789012\n'),
      logger,
      async batch => void records.push(...batch),
      { maxLineBytes: 11 }
    )

    expect(records).toEqual([{ ok: true }])
    expect(summary).toEqual({ invalidLines: 2, records: 1 })
    expect(warnings).toEqual([
      { reason: 'line_too_long', maxLineBytes: 11 },
      { reason: 'line_too_long', maxLineBytes: 11 }
    ])
  })

  it('counts the line limit in UTF-8 bytes', async () => {
    const { logger, warnings } = loggerWithWarnings()
    const records: unknown[] = []
    const summary = await consumeRecordBatches(
      stream('"é"\n'),
      logger,
      async batch => void records.push(...batch),
      { maxLineBytes: 3 }
    )

    expect(records).toEqual([])
    expect(summary).toEqual({ invalidLines: 1, records: 0 })
    expect(warnings).toEqual([{ reason: 'line_too_long', maxLineBytes: 3 }])
  })
})
