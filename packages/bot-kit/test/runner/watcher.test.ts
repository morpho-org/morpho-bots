import { describe, expect, it } from 'bun:test';

import type { Logger } from '../../src/logger';
import { createBlockWatcher } from '../../src/runner/watcher';

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// Flush microtasks + the macrotask queue so an in-flight async `onBlock` reaches its await point.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('createBlockWatcher', () => {
  it('runs onBlock once for a new height', async () => {
    const seen: bigint[] = [];
    const watcher = createBlockWatcher({
      getBlockNumber: async () => 100n,
      onBlock: async height => {
        seen.push(height);
      },
      logger: NOOP_LOGGER
    });
    await watcher.poll();
    expect(seen).toEqual([100n]);
  });

  it('does not re-run for a height it already processed', async () => {
    let height = 100n;
    const seen: bigint[] = [];
    const watcher = createBlockWatcher({
      getBlockNumber: async () => height,
      onBlock: async h => {
        seen.push(h);
      },
      logger: NOOP_LOGGER
    });
    await watcher.poll(); // 100 → run
    await watcher.poll(); // 100 → skip
    height = 105n;
    await watcher.poll(); // 105 → run
    expect(seen).toEqual([100n, 105n]);
  });

  it('coalesces intermediate heights while a run is in flight, processing only the latest', async () => {
    let height = 100n;
    const seen: bigint[] = [];
    let release: (() => void) | undefined;
    const watcher = createBlockWatcher({
      getBlockNumber: async () => height,
      onBlock: async h => {
        seen.push(h);
        // Block the first run so later polls pile up behind it.
        if (seen.length === 1) {
          await new Promise<void>(resolve => (release = resolve));
        }
      },
      logger: NOOP_LOGGER
    });

    const inFlight = watcher.poll(); // reads 100, starts onBlock(100), parks on the gate
    await flush();

    height = 101n;
    await watcher.poll(); // target=101, run is in flight → returns immediately
    height = 102n;
    await watcher.poll(); // target=102, still in flight

    release?.(); // onBlock(100) resolves → drain loop runs onBlock(102), skipping 101
    await inFlight;
    expect(seen).toEqual([100n, 102n]);
  });
});
