import type { Logger } from '@repo/bot-kit'

import { vi } from 'vitest'

import type { Alert, AlertDispatcher } from '../src/alerts/alert'

export function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

type CapturingDispatcher = AlertDispatcher & { sent: Alert[][]; failNext: () => void }

export function capturingDispatcher(): CapturingDispatcher {
  let fail = false
  const sent: Alert[][] = []
  return {
    sent,
    failNext: () => {
      fail = true
    },
    send: (alerts: Alert[]) => {
      if (fail) {
        fail = false
        return Promise.reject(new Error('dispatch failed'))
      }
      sent.push(alerts)
      return Promise.resolve()
    }
  }
}
