import { describe, expect, test } from 'vitest'

import { createCliLogger } from '../src/cli-logger.utils'

const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    output: {
      writeOut: (value: string) => void out.push(value),
      writeError: (value: string) => void err.push(value)
    }
  }
}

describe('createCliLogger', () => {
  test('writes human-readable results to stdout', () => {
    const { out, err, output } = capture()
    const logger = createCliLogger(output, { json: false, errorEvent: 'bot.error' })

    logger.result('ready')
    logger.result({ assets: 7n })

    expect(out).toEqual(['ready', '{\n  "assets": "7"\n}'])
    expect(err).toEqual([])
  })

  test('writes one machine-parseable JSON line per record in JSON mode', () => {
    const { out, output } = capture()
    const logger = createCliLogger(output, { json: true, errorEvent: 'bot.error' })

    logger.result({ status: 'published', assets: 7n })

    expect(out).toHaveLength(1)
    expect(out[0]).not.toContain('\n')
    expect(JSON.parse(out[0]!)).toEqual({ status: 'published', assets: '7' })
  })

  test('writes JSON errors with the caller-owned event name and optional details', () => {
    const { out, err, output } = capture()
    const logger = createCliLogger(output, { json: true, errorEvent: 'quoter-bot.error' })

    logger.error('setup failed', { checks: 9n })
    logger.error('usage')

    expect(out).toEqual([])
    expect(JSON.parse(err[0]!)).toEqual({
      level: 'error',
      event: 'quoter-bot.error',
      message: 'setup failed',
      details: { checks: '9' }
    })
    expect(JSON.parse(err[1]!)).toEqual({
      level: 'error',
      event: 'quoter-bot.error',
      message: 'usage'
    })
  })

  test('writes human-readable errors with pretty-printed details', () => {
    const { err, output } = capture()
    const logger = createCliLogger(output, { json: false, errorEvent: 'bot.error' })

    logger.error('setup failed', { ready: false })
    logger.error('usage')

    expect(err).toEqual(['Error: setup failed\n{\n  "ready": false\n}', 'Error: usage'])
  })
})
