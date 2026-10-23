import { ensureError, tryCatch } from '@repo/utils'

import type { Logger } from './logger'

export const HEARTBEAT_INTERVAL_MS = 60_000
export const HEARTBEAT_TIMEOUT_MS = 5_000

const parseHttpHeartbeatUrl = (value: string): URL | undefined => {
  try {
    const parsed = new URL(value.trim())
    return /^https?:$/.test(parsed.protocol) ? parsed : undefined
  } catch {
    return undefined
  }
}

type HeartbeatResponse = { ok: boolean; status: number }

type HeartbeatMonitor = Disposable & { start: () => Promise<void>; stop: () => void }

const INERT: HeartbeatMonitor = {
  start: async () => undefined,
  stop: () => undefined,
  [Symbol.dispose]: () => undefined
}

/**
 * Pings an optional Better Stack heartbeat URL on a wall-clock interval. Failures are logged but
 * never propagated to the runner, so external monitoring cannot interrupt liquidations. Declare it
 * with `using`: its live interval keeps the process alive and reporting healthy until stopped.
 */
export function createHeartbeatMonitor(deps: {
  url?: string
  logger: Logger
  intervalMs?: number
  ping?: (url: string) => Promise<HeartbeatResponse>
}): HeartbeatMonitor {
  const url = deps.url?.trim()
  if (!url) return INERT

  const parsed = parseHttpHeartbeatUrl(url)
  if (!parsed) {
    deps.logger.warn('heartbeat.misconfigured', {
      detail: 'BETTERSTACK_HEARTBEAT_URL must be an HTTP(S) URL — heartbeat disabled'
    })
    return INERT
  }

  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const ping =
    deps.ping ??
    (async (endpoint: string) =>
      fetch(endpoint, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) }))
  let timer: ReturnType<typeof setInterval> | null = null

  const pingHeartbeat = async () => {
    const response = await tryCatch(ping(url))
    if (response.error) {
      deps.logger.warn('heartbeat.failed', { detail: ensureError(response.error).message })
    } else if (!response.data.ok) {
      // `http_status`, not `status`: viem-dlc's wide events put their own string `status`
      // ("ok"/"error") at the top level of every record, and a source cannot hold one field as both
      // a string and an HTTP integer.
      deps.logger.warn('heartbeat.failed', { http_status: response.data.status })
    }
  }

  const stop = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
  return {
    async start() {
      if (timer !== null) return
      timer = setInterval(() => void pingHeartbeat(), intervalMs)
      await pingHeartbeat()
    },
    stop,
    [Symbol.dispose]: stop
  }
}
