import { describe, expect, test } from 'vitest'

import { withActiveSpan } from '../src/with-active-span.utils'

describe('withActiveSpan', () => {
  test('a throwing errorName projection never replaces the operation failure', async () => {
    const boom = new Error('boom')
    await expect(
      withActiveSpan(
        {
          name: 'quoter-bot.cycle',
          errorName: () => {
            throw new Error('classifier exploded')
          }
        },
        async () => {
          throw boom
        }
      )
    ).rejects.toBe(boom)
  })

  test('a throwing failed predicate never replaces the result', async () => {
    await expect(
      withActiveSpan(
        {
          name: 'quoter-bot.cycle',
          failed: () => {
            throw new Error('predicate exploded')
          }
        },
        async () => 'ok'
      )
    ).resolves.toBe('ok')
  })
})
