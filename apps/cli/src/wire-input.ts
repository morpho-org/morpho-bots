import type { Logger } from '@repo/evm-kit'

const DEFAULT_BATCH_SIZE = 256
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024

type InputSummary = { invalidLines: number; records: number }

/** Stream UTF-8 JSONL into bounded batches without imposing a schema on the records. */
export async function consumeRecordBatches(
  input: ReadableStream<Uint8Array>,
  logger: Logger,
  consume: (records: readonly unknown[]) => Promise<void>,
  limits: { batchSize?: number; maxLineBytes?: number } = {}
): Promise<InputSummary> {
  const batchSize = limits.batchSize ?? DEFAULT_BATCH_SIZE
  const maxLineBytes = limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  if (batchSize < 1 || maxLineBytes < 1) throw new Error('wire input limits must be positive')

  const summary: InputSummary = { invalidLines: 0, records: 0 }
  const batch: unknown[] = []
  const decoder = new TextDecoder()
  const reader = input.getReader()
  let lineParts: Uint8Array[] = []
  let lineBytes = 0
  let discardingOversizedLine = false

  const flush = async () => {
    if (batch.length === 0) return
    const records = batch.splice(0)
    await consume(records)
  }

  const parseLine = async (bytes: Uint8Array) => {
    const trimmed = decoder.decode(bytes).trim()
    if (trimmed === '') return
    try {
      batch.push(JSON.parse(trimmed))
      summary.records += 1
      if (batch.length === batchSize) await flush()
    } catch {
      summary.invalidLines += 1
      logger.warn('act.skip', { reason: 'malformed_line' })
    }
  }

  const rejectOversizedLine = () => {
    summary.invalidLines += 1
    logger.warn('act.skip', { reason: 'line_too_long', maxLineBytes })
  }

  const append = (bytes: Uint8Array) => {
    if (discardingOversizedLine || bytes.length === 0) return
    lineBytes += bytes.length
    if (lineBytes > maxLineBytes) {
      lineParts = []
      lineBytes = 0
      discardingOversizedLine = true
      rejectOversizedLine()
      return
    }
    lineParts.push(bytes)
  }

  const finishLine = async () => {
    if (discardingOversizedLine) {
      discardingOversizedLine = false
    } else {
      const line = new Uint8Array(lineBytes)
      let offset = 0
      for (const part of lineParts) {
        line.set(part, offset)
        offset += part.length
      }
      await parseLine(line)
    }
    lineParts = []
    lineBytes = 0
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let start = 0
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== 0x0a) continue
        append(value.subarray(start, index))
        await finishLine()
        start = index + 1
      }
      append(value.subarray(start))
    }
    if (!discardingOversizedLine && lineBytes > 0) await finishLine()
    await flush()
    return summary
  } finally {
    reader.releaseLock()
  }
}
