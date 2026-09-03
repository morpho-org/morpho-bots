import type { Hex } from 'viem'

import { describe, expect, it } from 'vitest'

import type { GetReceipt, TxReceiptLite } from '../../src/queue/pending-queue'

import { scanReceipts } from '../../src/queue/receipt.utils'

const NEWEST: Hex = `0x${'a'.repeat(64)}`
const MIDDLE: Hex = `0x${'b'.repeat(64)}`
const OLDEST: Hex = `0x${'c'.repeat(64)}`
const ALL = [NEWEST, MIDDLE, OLDEST]

const MINED: TxReceiptLite = { status: 'success', blockNumber: 42n }

/** Reads that resolve per hash: a `TxReceiptLite` mines, an `Error` fails, `null` is still pending. */
const reads =
  (by: Record<Hex, TxReceiptLite | Error | null>): GetReceipt =>
  async txHash => {
    const answer = by[txHash] ?? null
    if (answer instanceof Error) throw answer
    return answer
  }

describe('scanReceipts', () => {
  it('reports the newest hash when it is the one that mined', async () => {
    const scan = await scanReceipts(reads({ [NEWEST]: MINED }), ALL)
    expect(scan).toEqual({ kind: 'mined', txHash: NEWEST, receipt: MINED })
  })

  it('reports an older hash when a bump replaced the one that actually mined', async () => {
    const scan = await scanReceipts(reads({ [OLDEST]: MINED }), ALL)
    expect(scan).toEqual({ kind: 'mined', txHash: OLDEST, receipt: MINED })
  })

  it('prefers the newest of several receipts', async () => {
    const older: TxReceiptLite = { status: 'reverted', blockNumber: 7n }
    const scan = await scanReceipts(reads({ [NEWEST]: MINED, [OLDEST]: older }), ALL)
    expect(scan).toEqual({ kind: 'mined', txHash: NEWEST, receipt: MINED })
  })

  it('reports none only when every hash read cleanly and none had a receipt', async () => {
    expect(await scanReceipts(reads({}), ALL)).toEqual({ kind: 'none' })
  })

  it('reads past a failure on the newest hash to reach a mined older one', async () => {
    const scan = await scanReceipts(
      reads({ [NEWEST]: new Error('rpc down'), [OLDEST]: MINED }),
      ALL
    )
    expect(scan).toEqual({ kind: 'mined', txHash: OLDEST, receipt: MINED })
  })

  it('reports unknown when an OLDER hash failed, even though the newest read cleanly', async () => {
    // The mirror of the misreport this module exists to prevent: the unreadable hash is the one that
    // may have mined, so a clean `null` on the newest is not proof the nonce is ours to retire.
    const scan = await scanReceipts(reads({ [OLDEST]: new Error('rpc down') }), ALL)
    expect(scan).toEqual({ kind: 'unknown', error: expect.any(Error) })
  })

  it('surfaces the newest failure when several hashes failed', async () => {
    const newest = new Error('newest')
    const scan = await scanReceipts(reads({ [NEWEST]: newest, [OLDEST]: new Error('oldest') }), ALL)
    expect(scan).toEqual({ kind: 'unknown', error: newest })
  })

  it('lets a mined hash win over a failure on a hash that never mined', async () => {
    const scan = await scanReceipts(
      reads({ [NEWEST]: MINED, [OLDEST]: new Error('rpc down') }),
      ALL
    )
    expect(scan).toEqual({ kind: 'mined', txHash: NEWEST, receipt: MINED })
  })

  it('reports none for an empty hash list', async () => {
    expect(await scanReceipts(reads({}), [])).toEqual({ kind: 'none' })
  })
})
