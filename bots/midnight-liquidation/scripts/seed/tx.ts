// Shared plumbing for the position-seeding operator scripts: an interactive confirm and a
// simulate-then-send step. Both seeders talk to live Base with real keys, so every state-changing
// call is simulated immediately before it is sent and the run aborts on the first revert.

import type { Address, PublicClient, WalletClient } from 'viem'

import { createLogger } from '@repo/bot-kit'
import { delay as sleep, tryCatch } from '@repo/utils'
import { createInterface } from 'node:readline/promises'

/**
 * Re-simulation budget for a step whose dependency was just mined. A caching RPC can serve a read
 * that predates the previous transaction, which surfaces as a spurious simulation revert rather
 * than as staleness, so a failure is retried before it is believed.
 */
export const SIMULATE_RETRIES = 8
export const RETRY_DELAY_MS = 3000

// bun exposed a global synchronous `confirm()`; Node does not. Same contract: anything other than an
// explicit y/yes is a decline, and a non-interactive stdin declines rather than hanging a CI run.
export const confirmPrompt = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Simulates `call`, sends it, and waits for a successful receipt — throwing on a simulation error
 * that outlives {@link SIMULATE_RETRIES} or on an on-chain revert. Returns the simulated result, so
 * a caller can compare what the chain predicted against what it wants before continuing.
 */
export async function txStep({
  ctx,
  wallet,
  label,
  call
}: {
  ctx: { publicClient: PublicClient; logger: ReturnType<typeof createLogger> }
  wallet: WalletClient
  label: string
  // Heterogeneous contract call across several ABIs; typed loosely on purpose for a one-off script.
  call: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    value?: bigint
  }
}) {
  let sim = await tryCatch(
    ctx.publicClient.simulateContract({ account: wallet.account, ...call } as never)
  )
  for (let attempt = 1; sim.error && attempt < SIMULATE_RETRIES; attempt++) {
    // Likely the caching RPC lagging a just-mined dependency — wait and re-simulate.
    ctx.logger.warn('seed.simulate_retry', { step: label, attempt })
    await sleep(RETRY_DELAY_MS)
    sim = await tryCatch(
      ctx.publicClient.simulateContract({ account: wallet.account, ...call } as never)
    )
  }
  if (sim.error) {
    ctx.logger.error('seed.simulate_failed', { step: label, reason: sim.error.message })
    throw sim.error
  }
  ctx.logger.info('seed.simulate_ok', { step: label })
  const { request, result } = sim.data as unknown as { request: never; result: unknown }
  const hash = await wallet.writeContract(request)
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted on-chain (tx ${hash})`)
  ctx.logger.info('seed.tx', { step: label, txHash: hash })
  return result
}
