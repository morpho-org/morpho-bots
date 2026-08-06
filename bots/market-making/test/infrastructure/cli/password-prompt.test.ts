import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import { readPasswordInteractively } from '../../../src/infrastructure/cli/password-prompt.utils'

class FakeInput extends EventEmitter {
  isTTY = true
  rawModes: boolean[] = []
  pauses = 0
  resumes = 0

  constructor(
    private readonly failures: {
      setRawMode?: Error
      resume?: Error
    } = {}
  ) {
    super()
  }

  setRawMode(value: boolean) {
    this.rawModes.push(value)
    if (value && this.failures.setRawMode) throw this.failures.setRawMode
    return this
  }

  pause() {
    this.pauses += 1
    return this
  }

  resume() {
    this.resumes += 1
    if (this.failures.resume) throw this.failures.resume
    return this
  }
}

const prompt = (
  signal?: AbortSignal,
  failures: { outputWrite?: Error; setRawMode?: Error; resume?: Error } = {}
) => {
  const input = new FakeInput(failures)
  const writes: string[] = []
  const secretBytes: number[] = []
  const output = {
    isTTY: true,
    write: (value: string) => {
      if (failures.outputWrite) throw failures.outputWrite
      writes.push(value)
    }
  }
  const result = readPasswordInteractively({ input, output, signal, secretBytes })
  return { input, writes, result, secretBytes }
}

const expectClean = (input: FakeInput) => {
  expect(input.rawModes).toEqual([true, false])
  expect(input.pauses).toBe(1)
  expect(input.listenerCount('data')).toBe(0)
  expect(input.listenerCount('error')).toBe(0)
  expect(input.listenerCount('end')).toBe(0)
}

const expectWiped = (secretBytes: number[], length: number) => {
  expect(secretBytes).toEqual(Array.from({ length }, () => 0))
}

describe('hidden keystore password input', () => {
  test('defaults prompts and trailing newlines to stderr', async () => {
    const source = await readFile(
      `${import.meta.dir}/../../../src/infrastructure/cli/password-prompt.utils.ts`,
      'utf8'
    )

    expect(source).toContain('const output = options.output ?? process.stderr')
    expect(source).not.toContain('const output = options.output ?? process.stdout')
  })

  test('preserves split UTF-8 input and whitespace without echoing it, then wipes mutable bytes', async () => {
    const { input, writes, result, secretBytes } = prompt()
    const bytes = Buffer.from('  秘密🔐  ', 'utf8')
    input.emit('data', bytes.subarray(0, 5))
    input.emit('data', bytes.subarray(5))
    input.emit('data', Buffer.from('\n'))

    expect(await result).toBe('  秘密🔐  ')
    expect(writes).toEqual(['Keystore password: ', '\n'])
    expectWiped(secretBytes, bytes.length)
    expectClean(input)
  })

  test('preserves tab and non-reserved control bytes', async () => {
    const { input, result, secretBytes } = prompt()
    input.emit('data', Buffer.from([0x61, 0x09, 0x01, 0x62, 0x0a]))

    expect(await result).toBe('a\t\u0001b')
    expectWiped(secretBytes, 4)
    expectClean(input)
  })

  test('removes one Unicode code point on backspace and preserves remaining UTF-8', async () => {
    const { input, result, secretBytes } = prompt()
    input.emit('data', Buffer.from('秘密🔐', 'utf8'))
    input.emit('data', Buffer.from([0x7f, 0x0a]))

    expect(await result).toBe('秘密')
    expectWiped(secretBytes, Buffer.byteLength('秘密'))
    expectClean(input)
  })

  test.each(['error', 'end'] as const)(
    'wipes mutable bytes and cleans up after input %s',
    async event => {
      const { input, result, secretBytes } = prompt()
      input.emit('data', Buffer.from('partial-secret'))
      if (event === 'error') input.emit('error', new Error('stream failed'))
      else input.emit('end')
      await expect(result).rejects.toMatchObject({ code: 'INVALID_USAGE' })
      expectWiped(secretBytes, 'partial-secret'.length)
      expectClean(input)
    }
  )

  test('wipes mutable bytes and cleans up after Ctrl-C cancellation', async () => {
    const { input, result, secretBytes } = prompt()
    input.emit('data', Buffer.from('partial-secret'))
    input.emit('data', Buffer.from([3]))
    await expect(result).rejects.toMatchObject({ code: 'INVALID_USAGE' })
    expectWiped(secretBytes, 'partial-secret'.length)
    expectClean(input)
  })

  test('wipes mutable bytes and cleans up after raw Ctrl-D cancellation', async () => {
    const { input, result, secretBytes } = prompt()
    input.emit('data', Buffer.from('partial-secret'))
    input.emit('data', Buffer.from([0x04]))
    await expect(result).rejects.toMatchObject({ code: 'INVALID_USAGE' })
    expectWiped(secretBytes, 'partial-secret'.length)
    expectClean(input)
  })

  test.each([
    ['output.write', 'outputWrite'],
    ['setRawMode(true)', 'setRawMode'],
    ['resume', 'resume']
  ] as const)('cleans up without masking an original %s failure', async (_name, failureKey) => {
    const failure = new Error(`safe ${failureKey} failure`)
    const { input, result, secretBytes } = prompt(undefined, { [failureKey]: failure })

    await expect(result).rejects.toBe(failure)
    expect(secretBytes).toEqual([])
    expect(input.pauses).toBe(1)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(input.rawModes).toEqual(failureKey === 'outputWrite' ? [] : [true, false])
  })

  test('wipes mutable bytes and cleans up after abort termination', async () => {
    const controller = new AbortController()
    const { input, result, secretBytes } = prompt(controller.signal)
    input.emit('data', Buffer.from('partial-secret'))
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'INVALID_USAGE' })
    expectWiped(secretBytes, 'partial-secret'.length)
    expectClean(input)
  })
})
