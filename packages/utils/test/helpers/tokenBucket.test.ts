import { describe, expect, it } from 'bun:test';

import { createTokenBucket } from '../../src/helpers/tokenBucket';

describe('createTokenBucket', () => {
  it('serves the burst immediately, then sleeps 1/rps for the next token', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      rps: 1,
      burst: 1,
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      }
    });
    await bucket.take(); // consumes the 1 burst token, no sleep
    await bucket.take(); // empty → sleeps 1000ms (1/rps), then a token refills
    expect(sleeps).toEqual([1000]);
  });

  it('refills with elapsed time and caps at burst', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      rps: 2,
      burst: 2,
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      }
    });
    await bucket.take();
    await bucket.take(); // burst of 2 consumed without sleeping
    expect(sleeps).toEqual([]);

    clock += 10_000; // long idle refills at most `burst` tokens
    await bucket.take();
    await bucket.take(); // exactly 2 more without sleeping...
    expect(sleeps).toEqual([]);
    await bucket.take(); // ...then the shortfall is slept: 1/rps = 500ms
    expect(sleeps).toEqual([500]);
  });
});
