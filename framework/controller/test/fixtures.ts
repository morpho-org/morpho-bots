import type { KernelConfig, KernelEffects, LedgerStore, Validator } from '@repo/kernel'

import { FakeChain } from '@repo/kernel/testing'
import { setTimeout as sleep } from 'node:timers/promises'

export const EXECUTOR = '0xexecutor'
export const FEE = 10n ** 15n

/** A config whose one target is {@link EXECUTOR}, which `validator` claims. */
export const configFor = (validator: Validator, caps: KernelConfig['caps']): KernelConfig => ({
  chainId: 1,
  account: '0xbot',
  validators: [validator],
  policy: { targets: [EXECUTOR], recoveryTargets: [] },
  caps,
  observedResources: [],
  feeReserve: FEE,
  feePolicy: () => FEE,
  maxSimLagBlocks: 3,
  stuckBlocks: 3,
  maxEvidenceAgeBlocks: 64,
  latchBoundBlocks: 100,
  recoveryBoundMs: 60_000,
  revokeAfterStaleMs: 3_600_000,
  maxRecoveryAttempts: 3,
  maxDispatchLagMs: 5_000
})

/** A fake chain that mines each accepted broadcast into a block that is final at once, and a ledger that keeps nothing. */
export const dryWorld = () => {
  const chain = new FakeChain()
  chain.finalityLag = 0
  const effects: KernelEffects = {
    ...chain.effects,
    broadcast: async (raw, guard) => {
      const sent = await chain.effects.broadcast(raw, guard)
      if (sent === 'accepted') chain.mine()
      return sent
    }
  }
  const store: LedgerStore = { read: async () => null, write: async () => {} }
  return { chain, effects, store }
}

/** Hosts a kernel on a {@link dryWorld}, on a clock that stands at 0. */
export const dryHosting = (config: KernelConfig) => ({
  ...dryWorld(),
  config,
  enrollment: 'enrolling' as const,
  pollMs: 5,
  effectTimeoutMs: 1_000,
  reorgDepth: 16,
  onError: () => {},
  now: () => 0
})

export const until = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 5_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}
