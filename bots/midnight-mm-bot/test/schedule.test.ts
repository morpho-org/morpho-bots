import { describe, expect, it } from 'bun:test'

import { publicationEpochs } from '../src/schedule'
describe('publicationEpochs', () => {
  it('returns current epoch', () =>
    expect(publicationEpochs({ now: 3700n, ttlSeconds: 3600, leadSeconds: 300 })).toEqual([3600n]))
  it('pre-publishes next epoch', () =>
    expect(publicationEpochs({ now: 6900n, ttlSeconds: 3600, leadSeconds: 300 })).toEqual([
      3600n,
      7200n
    ]))
})
