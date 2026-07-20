/**
 * A simple token bucket: `tokens` refills at `rps` per second up to `burst`. `take()` resolves once
 * a token is available, sleeping the shortfall otherwise. Pure but for the injected `now`/`sleep`,
 * so it is deterministically testable.
 *
 * @param opts - Bucket parameters: `rps` refill rate (tokens/second), `burst` capacity, and the
 * injected `now` (ms clock) and `sleep` (ms) used to meter refills.
 * @returns A bucket whose `take()` resolves when a token has been consumed.
 */
export function createTokenBucket(opts: {
  rps: number;
  burst: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): { take: () => Promise<void> } {
  const { rps, burst, now, sleep } = opts;
  let tokens = burst;
  let last = now();
  return {
    async take() {
      for (;;) {
        const t = now();
        tokens = Math.min(burst, tokens + ((t - last) / 1000) * rps);
        last = t;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - tokens) / rps) * 1000));
      }
    }
  };
}
