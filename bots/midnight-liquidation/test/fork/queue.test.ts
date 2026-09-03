import { createLogger, createPendingQueue, createSigner, initialFees } from '@repo/bot-kit'
import { parseGwei } from 'viem'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  type ForkHandle,
  fundEth,
  LIQUIDATOR,
  LIQUIDATOR_KEY,
  startFork,
  stopFork,
  testClient,
  type TestClient
} from './harness'

// Generous ceiling so the EIP-1559 bump never trips the `drop` path; the test is about replacement
// landing, not the gas-spike ceiling (that is unit-tested in fee-policy.test.ts).
const MAX_FEE_WEI = parseGwei('10000')

describe('fork: pending-queue bump + replacement against a real node', () => {
  let anvil: ForkHandle
  let test: TestClient
  let rpcUrl: string

  beforeAll(async () => {
    const fork = await startFork(8548) // see the port registry in harness.ts
    anvil = fork.anvil
    rpcUrl = fork.rpcUrl
    test = testClient(rpcUrl)
    // Automining off → broadcast txs sit in the mempool unmined, so we can drive the stuck-detection
    // path deterministically by advancing the block counter we feed to onBlock without confirming.
    await test.setAutomine(false)
    await fundEth(test, LIQUIDATOR)
  }, 60_000)

  afterAll(async () => {
    await stopFork(anvil)
  })

  it('bumps a stuck tx and the replacement lands at the same nonce', async () => {
    const cfg = {
      chain: base,
      rpcUrl,
      rpcUrlFallback: undefined,
      privateKey: LIQUIDATOR_KEY
    }
    const signer = createSigner(cfg)
    const queue = createPendingQueue({
      send: signer.send,
      getReceipt: signer.getReceipt,
      getBaseFee: signer.getBaseFee,
      syncNonce: signer.syncNonce,
      maxFeeWei: MAX_FEE_WEI,
      logger: createLogger('error')
    })

    // 1. Submit a trivial self-send through the real signer path; it sits unmined (automining off).
    const fees = initialFees(await signer.getBaseFee(), MAX_FEE_WEI, parseGwei('0.1'))
    await queue.submit({
      request: { to: LIQUIDATOR, data: '0x' },
      label: 'queue-fork',
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    })
    expect(queue.size).toBe(1)
    const original = queue.snapshot()[0]
    if (!original) throw new Error('expected a pending entry')
    expect(original.attempt).toBe(0)

    // 2. Advance without mining → real getReceipt returns null, so onBlock detects the stuck tx and
    //    replaces it at the same nonce with ≥12.5% higher fees (a fresh hash). Block 1 only sights
    //    the entry, so the bump lands at sighting + STUCK_BLOCKS (4) + 1 = block 6.
    for (let block = 1n; block <= 6n; block++) await queue.onBlock(block)
    const bumped = queue.snapshot()[0]
    if (!bumped) throw new Error('expected the bumped entry to remain pending')
    expect(queue.size).toBe(1)
    expect(bumped.nonce).toBe(original.nonce)
    expect(bumped.attempt).toBe(1)
    expect(bumped.txHash).not.toBe(original.txHash)

    // 3. Mine once: anvil keeps the higher-fee tx for that nonce, so the replacement lands. onBlock then
    //    sees the receipt and clears the queue.
    await test.mine({ blocks: 1 })
    await queue.onBlock(6n)
    expect(queue.size).toBe(0)

    // The replacement (not the original) is the tx that confirmed.
    const receipt = await test.getTransactionReceipt({ hash: bumped.txHash })
    expect(receipt.status).toBe('success')
  }, 120_000)
})
