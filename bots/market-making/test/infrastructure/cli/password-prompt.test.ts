import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { readPasswordInteractively } from '../../../src/infrastructure/cli/password-prompt.utils'

class FakeInput extends EventEmitter {
  isTTY = true
  rawModes: boolean[] = []
  pauses = 0
  resumes = 0

  setRawMode(value: boolean) {
    this.rawModes.push(value)
    return this
  }

  pause() {
    this.pauses += 1
    return this
  }

  resume() {
    this.resumes += 1
    return this
  }
}

const prompt = (signal?: AbortSignal) => {
  const input = new FakeInput()
  const writes: string[] = []
  const secretBytes: number[] = []
  const output = { isTTY: true, write: (value: string) => writes.push(value) }
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
