import type { KernelState } from '@repo/kernel'
import type { Address } from 'viem'

import { keyRecord } from '@repo/engine'
import { factId } from '@repo/kernel'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

import { recordingJournal, startBot, until, vaultAt } from './bot'

type Bot = Awaited<ReturnType<typeof startBot>>

const gate = () => {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

const bots: Bot[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
})

const started = async (parameters: Parameters<typeof startBot>[0] = {}) => {
  const bot = await startBot(parameters)
  bots.push(bot)
  await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
  return bot
}

const planOf = (state: KernelState, vault: Address) =>
  Object.values(state.plans).find(plan => plan.intentId.startsWith(`${vault}#`))
const candidatesOf = (state: KernelState, vault: Address) =>
  Object.values(state.nonces).flatMap(record =>
    record.candidates.filter(candidate => candidate.intentId.startsWith(`${vault}#`))
  )
const absent = (state: KernelState, vault: Address) => {
  const observation = state.observations[factId('vaults.reallocation', vault)]
  return observation !== undefined && 'version' in observation && observation.version === 'absent'
}
const fieldsOf = (bot: Bot, event: string) => bot.events(event).map(line => line.fields)

describe('the Vault V1 reallocator on the engine', () => {
  it('is neutral: a reallocation creates no commitment and consumes nothing', async () => {
    const vault = vaultAt(1)
    const bot = await started()
    const signing = bot.chain.holdSigning()
    bot.unbalanced.add(vault)
    bot.mining(true)
    await until(() => planOf(bot.state(), vault)?.phase === 'sign', 'the signature request')
    expect(planOf(bot.state(), vault)!.envelope).toStrictEqual({ ids: [], consumes: {} })
    expect(planOf(bot.state(), vault)!.steps[0]!.reading).toMatchObject({
      creates: [],
      exposes: [],
      consumes: {}
    })
    signing.open()
  })

  it('reallocates each unbalanced vault independently, and leaves a balanced one alone', async () => {
    const [a, b, c] = [vaultAt(1), vaultAt(2), vaultAt(3)]
    const bot = await started({ vaults: [a, b, c], unbalanced: new Set([a, b]) })
    bot.mining(true)
    await until(() => bot.events('tx.included').length === 2, 'both confirmations')
    expect(bot.unbalanced.size).toBe(0)
    expect(new Set(fieldsOf(bot, 'tx.included').map(fields => fields.id))).toStrictEqual(
      new Set([a, b])
    )
    expect(new Set(fieldsOf(bot, 'reallocation.found').map(fields => fields.vault))).toStrictEqual(
      new Set([a, b])
    )
    const wanted = () => bot.runner.read(bot.nodes.reallocationFacts)!
    await until(
      () => [a, b].every(vault => keyRecord(wanted(), vault).status === 'absent'),
      'the balanced reads'
    )
    expect(bot.chain.signed).toHaveLength(2)
    expect(candidatesOf(bot.state(), c)).toStrictEqual([])
    expect(bot.events('kernel.alarm')).toStrictEqual([])
  })

  it('never sends a vault again on the read its own reallocation made stale', async () => {
    const vault = vaultAt(1)
    const bot = await started({
      vaults: [vault],
      unbalanced: new Set([vault]),
      intervalMs: 60 * 60_000
    })
    bot.mining(true)
    await until(() => bot.events('tx.included').length === 1, 'the settlement')
    const settledAt = bot.state().head!.number
    await until(() => bot.state().head!.number >= settledAt + 3, 'blocks after the settlement')
    expect(keyRecord(bot.runner.read(bot.nodes.candidates)!, vault).status).toBe('present')
    expect(bot.events('reallocation.not_broadcast')).toStrictEqual([])
    expect(bot.chain.signed).toHaveLength(1)
  })

  it('admits no read while one is in flight, however long it stalls', async () => {
    const bot = await started({ intervalMs: 10 })
    bot.world.readDelayMs = 1_500
    bot.mining(true)
    const before = bot.world.readAt.length
    await until(() => bot.world.readAt.length >= before + 2, 'a read after the slow one', 10_000)
    const [slow, next] = bot.world.readAt.slice(before)
    expect(next! - slow!).toBeGreaterThanOrEqual(1_500 - 5)
    expect(bot.world.mostReading).toBe(1)
    expect(bot.state().lifecycle.kind).toBe('running')
  })

  it('keeps a whole interval between reads when the first read is late', async () => {
    const chain = new FakeChain()
    const stalled = gate()
    chain.stall = stalled.opened
    const intervalMs = 300
    const bot = await startBot({ chain, intervalMs })
    bots.push(bot)
    await sleep(intervalMs / 2)
    chain.stall = undefined
    stalled.open()
    bot.mining(true)
    await until(() => bot.world.readAt.length >= 3, 'three reads', 10_000)
    const [first, second, third] = bot.world.readAt
    expect(second! - first!).toBeGreaterThanOrEqual(intervalMs - 5)
    expect(third! - second!).toBeGreaterThanOrEqual(intervalMs - 5)
  })

  it('reads at the first head and then once per interval', async () => {
    // Past 2^31 - 1 ms, which a Node timer would have clamped to 1 ms.
    const bot = await started({ intervalMs: 30 * 24 * 60 * 60_000 })
    bot.mining(true)
    await until(() => bot.events('tick.end').length === 1, 'the first read')
    const head = bot.state().head!.number
    await until(() => bot.state().head!.number >= head + 5, 'five more heads')
    expect(bot.world.reads).toBe(1)
    expect(fieldsOf(bot, 'tick.end')[0]).toMatchObject({
      vaults: 2,
      reallocations_found: 0,
      errors: 0,
      missing_role: 0
    })
  })

  it('skips a vault whose account holds no allocator role, and logs it', async () => {
    const vault = vaultAt(1)
    const bot = await started({ vaults: [vault], unbalanced: new Set([vault]), unroled: [vault] })
    bot.mining(true)
    await until(() => bot.events('allocator.missing_role').length > 0, 'the missing role')
    expect(fieldsOf(bot, 'allocator.missing_role')[0]).toStrictEqual({ vault })
    expect(bot.chain.signed).toStrictEqual([])
  })

  it('in a dry run simulates each read and hands the kernel nothing', async () => {
    const vault = vaultAt(1)
    const bot = await started({ vaults: [vault], unbalanced: new Set([vault]), dryRun: true })
    bot.mining(true)
    await until(() => bot.events('reallocation.dry_run').length >= 2, 'two dry runs')
    expect(fieldsOf(bot, 'reallocation.dry_run')[0]).toStrictEqual({ vault })
    expect(Object.keys(bot.state().plans)).toStrictEqual([])
    expect(bot.chain.signed).toStrictEqual([])
  })

  it('declines a reverting simulation until the next read, then acts', async () => {
    const vault = vaultAt(1)
    const bot = await started({
      vaults: [vault],
      unbalanced: new Set([vault]),
      simulateReverts: true
    })
    bot.mining(true)
    await until(() => bot.events('reallocation.sim_revert').length >= 2, 'reverts on two reads')
    expect(fieldsOf(bot, 'reallocation.sim_revert')[0]).toStrictEqual({
      vault,
      reason: 'SupplyCapExceeded'
    })
    expect(bot.chain.signed).toStrictEqual([])
    bot.world.simulateReverts = false
    await until(() => bot.events('tx.included').length === 1, 'the settlement')
    expect(bot.events('tick.end').some(line => Number(line.fields.sim_reverts) > 0)).toBe(true)
  })

  it('withdraws an act whose vault no longer wants it before the signature', async () => {
    const vault = vaultAt(1)
    const bot = await started({ vaults: [vault] })
    const signing = bot.chain.holdSigning()
    bot.unbalanced.add(vault)
    bot.mining(true)
    await until(() => planOf(bot.state(), vault)?.phase === 'sign', 'the signature request')
    bot.unbalanced.delete(vault)
    await until(() => absent(bot.state(), vault), 'the balanced read')
    signing.open()
    await until(() => planOf(bot.state(), vault) === undefined, 'the refused signature')
    expect(bot.chain.signed).toStrictEqual([])
    expect(candidatesOf(bot.state(), vault)).toStrictEqual([])
  })

  it('stops acting on a vault once failed reads let its fact expire', async () => {
    const vault = vaultAt(1)
    const clock = { skew: 0 }
    const bot = await started({ vaults: [vault], now: () => Date.now() + clock.skew })
    const simulation = gate()
    bot.world.simulateGate = simulation.opened
    bot.unbalanced.add(vault)
    bot.mining(true)
    await until(() => bot.world.simulations === 1, 'the preparation in flight')
    bot.world.readFails = true
    await until(
      () => bot.runner.read(bot.nodes.vaults)?.coverage.status === 'failed',
      'a failed read'
    )
    clock.skew = 120_000
    simulation.open()
    await until(() => bot.events('act.dropped').length === 1, 'the dropped act')
    expect(fieldsOf(bot, 'act.dropped')).toStrictEqual([
      { id: vault, task: 'reallocate', reason: 'fact_expired' }
    ])
    expect(bot.events('act.submitted')).toStrictEqual([])
    expect(bot.chain.signed).toStrictEqual([])

    bot.world.readFails = false
    await until(() => bot.events('tx.included').length === 1, 'the reallocation on a fresh read')
  })

  it('fails a read it could not make without changing any vault', async () => {
    const [a, b] = [vaultAt(1), vaultAt(2)]
    const bot = await started({ vaults: [a, b] })
    bot.mining(true)
    await until(() => bot.events('tick.end').length > 0, 'the first read')
    const vaults = () => bot.runner.read(bot.nodes.vaults)!
    bot.world.unserved.add(b)
    await until(() => keyRecord(vaults(), b).status === 'failed', 'a partly served read')
    expect(keyRecord(vaults(), a).status).toBe('present')
    expect(fieldsOf(bot, 'vault.error')).toContainEqual({
      vault: b,
      reason: 'lens returned no row for this vault'
    })
    bot.world.readFails = true
    await until(() => vaults().coverage.status === 'failed', 'the failed read')
    expect(keyRecord(vaults(), a).status).toBe('present')
    await until(
      () => fieldsOf(bot, 'tick.end').some(fields => fields.errors === 2),
      'the failed tick.end'
    )
    expect(fieldsOf(bot, 'vault.error')).toContainEqual({ vault: a, reason: expect.any(String) })
  })
})

describe('the Vault V1 reallocator over its lifecycle', () => {
  it('finalizes its journal unclean when its graph cannot be declared', async () => {
    const { journal, finalized } = recordingJournal()
    await expect(startBot({ journal, intervalMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow()
    expect(finalized).toStrictEqual([{ clean: false }])
  })

  it('stops clean on Stop once its reallocation is final, and finalizes its journal', async () => {
    const vault = vaultAt(1)
    const { journal, finalized } = recordingJournal()
    const bot = await started({ journal, unbalanced: new Set([vault]) })
    bot.mining(true)
    await until(() => bot.events('tx.sent').length === 1, 'the send')
    bot.stop()
    expect((await bot.stopped).outcome).toBe('clean')
    expect(bot.unbalanced.size).toBe(0)
    expect(finalized).toHaveLength(1)
  })

  it('restarts over the same ledger under a new run id and acts again', async () => {
    const [a, b] = [vaultAt(1), vaultAt(2)]
    const chain = new FakeChain()
    const store = new MemoryStore()
    const first = await started({ chain, store, unbalanced: new Set([a]) })
    first.mining(true)
    await until(() => first.events('tx.included').length === 1, 'the first reallocation')
    first.stop()
    expect((await first.stopped).outcome).toBe('clean')
    first.mining(false)
    const second = await started({
      chain,
      store,
      runId: 'run-2',
      enrollment: 'enrolled',
      unbalanced: new Set([b])
    })
    second.mining(true)
    await until(() => second.events('tx.included').length === 1, 'the second reallocation')
    expect(fieldsOf(second, 'tx.included')[0]!.id).toBe(b)
    expect(chain.signed).toHaveLength(2)
  })
})
