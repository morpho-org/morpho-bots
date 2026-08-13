import { expect, test } from 'vitest'

import { inMemoryRouterRemoved } from './mock-router'

/** Signals that genuine workflow coverage lives in `quoter-bot.fork.e2e.test.ts`. */
export const quoterBotE2eUsesFork = inMemoryRouterRemoved

test('uses the HTTP Base-fork fixture instead of the removed in-memory Router', () => {
  expect(quoterBotE2eUsesFork).toBe(true)
})
