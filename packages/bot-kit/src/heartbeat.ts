import { ensureError, tryCatch } from '@repo/utils';

import type { Logger } from './logger';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;

type HeartbeatResponse = { ok: boolean; status: number };

/**
 * Pings an optional Better Stack heartbeat URL on a wall-clock interval. Failures are logged but
 * never propagated to the runner, so external monitoring cannot interrupt liquidations.
 */
export function createHeartbeatMonitor(deps: {
  url?: string;
  logger: Logger;
  intervalMs?: number;
  ping?: (url: string) => Promise<HeartbeatResponse>;
}): { start: () => Promise<void>; stop: () => void } {
  const url = deps.url?.trim();
  if (!url) {
    return { start: async () => undefined, stop: () => undefined };
  }

  const parsed = tryCatch(() => new URL(url));
  if (parsed.error || !/^https?:$/.test(parsed.data.protocol)) {
    deps.logger.warn('heartbeat.misconfigured', {
      detail: 'BETTERSTACK_HEARTBEAT_URL must be an HTTP(S) URL — heartbeat disabled'
    });
    return { start: async () => undefined, stop: () => undefined };
  }

  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const ping =
    deps.ping ??
    (async (endpoint: string) =>
      fetch(endpoint, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) }));
  let timer: ReturnType<typeof setInterval> | null = null;

  const pingHeartbeat = async () => {
    const response = await tryCatch(ping(parsed.data.toString()));
    if (response.error) {
      deps.logger.warn('heartbeat.failed', { detail: ensureError(response.error).message });
    } else if (!response.data.ok) {
      deps.logger.warn('heartbeat.failed', { status: response.data.status });
    }
  };

  return {
    async start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => void pingHeartbeat(), intervalMs);
      await pingHeartbeat();
    },
    stop() {
      if (timer === null) {
        return;
      }
      clearInterval(timer);
      timer = null;
    }
  };
}
