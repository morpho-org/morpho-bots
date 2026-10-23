import type { Authored, Block, KernelConfig, LedgerStore, PlanInput, Validator } from '@repo/kernel'
import type { ChildProcess } from 'node:child_process'
import type { Hex } from 'viem'

import { startKernel } from '@repo/kernel/testing'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTestClient, http, parseGwei, parseTransaction, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createKernelChain } from '../src/kernel-chain'
import { createKernelEffects } from '../src/kernel-effects'
import { createAccountSigner } from '../src/signer'

// 8551 is this suite's slot in the repo-wide anvil port registry (bots/blue-liquidation/test/fork/harness.ts).
const PORT = 8551
const RPC = `http://127.0.0.1:${PORT}`
const SINK = '0x000000000000000000000000000000000000dead'
const REVERTER = '0x00000000000000000000000000000000000fa11e'
const MAX_FEE = parseGwei('50')

/** Anvil's published development keys; each test runs as its own account on the shared chain. */
const KEYS: readonly Hex[] = [
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
]

const hasAnvil = spawnSync('anvil', ['--version']).status === 0
const client = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) }).extend(
  publicActions
)

const kernelFor = (key: Hex) => {
  const account = privateKeyToAccount(key)
  const signer = createAccountSigner({
    account,
    chain: foundry,
    rpcUrl: RPC,
    policy: {
      chainId: foundry.id,
      targets: [SINK],
      rules: [{ target: SINK, maxGasLimit: 100_000n, maxDataBytes: 1 }],
      maxFeePerGasWei: MAX_FEE,
      maxGasLimit: 100_000n,
      maxSpendWei: MAX_FEE * 100_000n,
      maxDataBytes: 1
    }
  })
  const chain = createKernelChain({
    client,
    account: account.address,
    finality: { depth: 2 },
    commitment: () => Promise.reject(new Error('no commitments'))
  })
  const effects = createKernelEffects({
    client,
    signer,
    maxFeePerGasWei: MAX_FEE,
    priorityFeePerGasWei: parseGwei('1'),
    maxGasLimit: 100_000n,
    materialize: () => Promise.reject(new Error('nothing to materialize'))
  })
  return { account, signer, chain, effects }
}

const until = async (done: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 20_000
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

const payload = { kind: 'tx' as const, to: SINK, data: '0x01', value: 0n }
const open = () => new AbortController().signal
const guard = (mayAct: boolean) => ({ signal: open(), mayAct: () => mayAct })

describe.skipIf(!hasAnvil)(
  'the kernel chain and effects against a local chain',
  { timeout: 30_000 },
  () => {
    let anvil: ChildProcess | undefined

    beforeAll(async () => {
      anvil = spawn('anvil', ['--port', String(PORT), '--no-mining'], { stdio: 'ignore' })
      await until(
        () =>
          client.getChainId().then(
            () => true,
            () => false
          ),
        'anvil'
      )
      await client.setCode({ address: REVERTER, bytecode: '0x60006000fd' })
      await client.mine({ blocks: 4 })
    })

    afterAll(() => {
      anvil?.kill('SIGKILL')
    })

    it('reads finality a fixed depth below the head, and blocks with their parent links', async () => {
      const { chain } = kernelFor(KEYS[0]!)
      const { head, finalized } = await chain.latest()
      expect(finalized.number).toBe(head.number - 2)
      const parent = await chain.block(head.number - 1)
      expect(head.parentHash).toBe(parent.hash)
      expect(await chain.accountCode()).toBe('0x')
    })

    it("reads the chain's own finality tag when told to, and refuses a meaningless depth", async () => {
      const { account } = kernelFor(KEYS[0]!)
      const commitment = () => Promise.reject(new Error('no commitments'))
      const tagged = createKernelChain({
        client,
        account: account.address,
        finality: 'safe',
        commitment
      })
      const [{ head, finalized }, safe] = await Promise.all([
        tagged.latest(),
        client.getBlock({ blockTag: 'safe' })
      ])
      expect(finalized.number).toBe(Number(safe.number))
      expect(finalized.number <= head.number).toBe(true)
      expect(() =>
        createKernelChain({ client, account: account.address, finality: { depth: -1 }, commitment })
      ).toThrow('finality must be safe, finalized, or a non-negative integer depth')
    })

    it('pins nonce reads to a block by hash and refuses a hash the chain does not hold', async () => {
      const { chain } = kernelFor(KEYS[0]!)
      const { head } = await chain.latest()
      expect(await chain.nonceAt(head)).toEqual({ latest: 0, pending: 0 })
      const unknown: Block = { ...head, hash: `0x${'ee'.repeat(32)}` }
      await expect(chain.nonceAt(unknown)).rejects.toThrow()
    })

    it('simulates at the kernel block and tells a revert from a failed read', async () => {
      const { chain, effects } = kernelFor(KEYS[0]!)
      const { head } = await chain.latest()
      expect(await effects.simulate(payload, head, open())).toBe(true)
      expect(await effects.simulate({ ...payload, to: REVERTER }, head, open())).toBe(false)
      const unknown: Block = { ...head, hash: `0x${'ee'.repeat(32)}` }
      await expect(effects.simulate(payload, unknown, open())).rejects.toThrow()
    })

    it('outbids its own candidate on a replacement, within the spend ceiling', async () => {
      const { effects } = kernelFor(KEYS[1]!)
      const spend = MAX_FEE * 100_000n
      const first = await effects.signTx(payload, { nonce: 0, fee: spend, level: 1 }, guard(true))
      expect(await effects.broadcast(first.raw, guard(true))).toBe('accepted')
      const second = await effects.signTx(payload, { nonce: 0, fee: spend, level: 2 }, guard(true))
      const [a, b] = [parseTransaction(first.raw as Hex), parseTransaction(second.raw as Hex)]
      expect(b.maxPriorityFeePerGas! > a.maxPriorityFeePerGas!).toBe(true)
      expect(b.maxFeePerGas! > a.maxFeePerGas!).toBe(true)
      expect(b.gas! * b.maxFeePerGas! <= spend).toBe(true)
      expect(await effects.broadcast(second.raw, guard(true))).toBe('accepted')
      await client.mine({ blocks: 1 })
      expect((await client.getTransactionReceipt({ hash: second.hash as Hex })).status).toBe(
        'success'
      )
    })

    it('outbids a pending candidate whose fees it never saw, as after a restart', async () => {
      const before = kernelFor(KEYS[2]!)
      const spend = MAX_FEE * 100_000n
      const first = await before.effects.signTx(
        payload,
        { nonce: 0, fee: spend, level: 1 },
        guard(true)
      )
      expect(await before.effects.broadcast(first.raw, guard(true))).toBe('accepted')
      const restarted = kernelFor(KEYS[2]!)
      const second = await restarted.effects.signTx(
        payload,
        { nonce: 0, fee: spend, level: 2 },
        guard(true)
      )
      // geth refuses a replacement that does not raise both fees by 10% (txpool `PriceBump`).
      const [a, b] = [parseTransaction(first.raw as Hex), parseTransaction(second.raw as Hex)]
      expect(b.maxPriorityFeePerGas! * 10n >= a.maxPriorityFeePerGas! * 11n).toBe(true)
      expect(b.maxFeePerGas! * 10n >= a.maxFeePerGas! * 11n).toBe(true)
      expect(b.gas! * b.maxFeePerGas! <= spend).toBe(true)
      expect(await restarted.effects.broadcast(second.raw, guard(true))).toBe('accepted')
      await client.mine({ blocks: 1 })
      expect((await client.getTransactionReceipt({ hash: second.hash as Hex })).status).toBe(
        'success'
      )
    })

    it('sends nothing once dispatch is withdrawn, rejects a stale bid, and refuses a zero ceiling', async () => {
      const { effects, account } = kernelFor(KEYS[4]!)
      const fee = MAX_FEE * 100_000n
      await expect(
        effects.signTx(payload, { nonce: 0, fee, level: 1 }, guard(false))
      ).rejects.toThrow('withdrawn')
      const signed = await effects.signTx(payload, { nonce: 0, fee, level: 1 }, guard(true))
      await expect(effects.broadcast(signed.raw, guard(false))).rejects.toThrow('withdrawn')
      expect(
        await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
      ).toBe(0)
      const stale = await effects.signTx(
        payload,
        { nonce: 0, fee: 100_000n, level: 1 },
        guard(true)
      )
      expect(await effects.broadcast(stale.raw, guard(true))).toBe('rejected')
      await expect(
        effects.signTx(payload, { nonce: 0, fee: 1n, level: 1 }, guard(true))
      ).rejects.toThrow('cannot fund a positive per-gas bid')
    })

    it('finds the transaction that consumed a nonce, and nothing for a nonce still unused', async () => {
      const { chain, effects } = kernelFor(KEYS[3]!)
      const fee = MAX_FEE * 100_000n
      for (const nonce of [0, 1, 2]) {
        const signed = await effects.signTx(payload, { nonce, fee, level: 1 }, guard(true))
        await effects.broadcast(signed.raw, guard(true))
        await client.mine({ blocks: 2 })
      }
      const found = await chain.nonceTx(1)
      const receipt = await client.getTransactionReceipt({ hash: found!.hash as Hex })
      expect(found).toMatchObject({ block: Number(receipt.blockNumber), status: 'success' })
      expect(found!.blockHash).toBe(receipt.blockHash)
      expect(await chain.nonceTx(3)).toBeNull()
    })

    it('drives a kernel plan from submission to settlement', async () => {
      const { account, chain, effects } = kernelFor(KEYS[0]!)
      const validator: Validator = {
        id: 'sink',
        version: 1,
        claims: p => p.kind === 'tx' && p.to === SINK,
        read: () => ({
          ok: true,
          creates: [],
          exposes: [],
          carries: [],
          retires: [],
          consumes: {}
        }),
        confirm: () => true
      }
      const fee = MAX_FEE * 100_000n
      const config: KernelConfig = {
        chainId: foundry.id,
        account: account.address,
        validators: [validator],
        policy: { targets: [SINK], recoveryTargets: [account.address] },
        caps: { native: 10n * fee },
        observedResources: [],
        feeReserve: fee,
        feePolicy: () => fee,
        maxSimLagBlocks: 4,
        stuckBlocks: 4,
        maxEvidenceAgeBlocks: 64,
        latchBoundBlocks: 8,
        recoveryBoundMs: 60_000,
        revokeAfterStaleMs: 3_600_000,
        maxRecoveryAttempts: 3,
        maxDispatchLagMs: 5_000
      }
      let ledger: unknown = null
      const store: LedgerStore = {
        read: () => Promise.resolve(ledger),
        write: written => {
          ledger = written
          return Promise.resolve()
        }
      }
      const notices: string[] = []
      const { runner, nodes } = await startKernel({
        config,
        store,
        chain,
        effects,
        enrollment: 'enrolling',
        pollMs: 20,
        effectTimeoutMs: 5_000,
        reorgDepth: 16,
        onError: () => {},
        journal: {
          sink: { append: async () => undefined, finalize: async () => undefined },
          capacityBytes: 1_000_000
        },
        onActivity: activity => {
          for (const a of activity) if (a.type === 'notice') notices.push(a.notice)
        }
      })
      const mining = setInterval(() => void client.mine({ blocks: 1 }), 50)
      try {
        const state = () => runner.read(nodes.state)!
        await until(() => state().lifecycle.kind === 'running', 'running')
        const plan: PlanInput = {
          intentId: 'sink:1',
          steps: [{ kind: 'tx', payload }],
          notAfter: Date.now() + 60_000,
          basisBlock: state().head!.number
        }
        runner.push(nodes.requests, { type: 'Submit', plan: plan as PlanInput & Authored<'plan'> })
        await until(() => notices.includes('settled'), 'settlement')
      } finally {
        clearInterval(mining)
        await runner.abandon()
      }
    })
  }
)
