import type { ChildProcess } from 'node:child_process'
import type { Hex, PrivateKeyAccount } from 'viem'

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createTestClient,
  http,
  keccak256,
  publicActions,
  RpcError,
  TransactionReceiptNotFoundError
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  Block,
  KernelChain,
  KernelEffects,
  KernelConfig,
  LedgerStore,
  PlanInput,
  TxPayload
} from '../src'
import type { RawRequest } from './fixtures'

import { createLedgerStore } from '../src'
import { startKernel } from '../src/testing'
import { encodeCall } from './codec'
import { unauthored } from './fixtures'
import { noCommitmentsValidator } from './validators'

// 8552 is this suite's slot in the repo-wide anvil port registry (bots/blue-liquidation/test/fork/harness.ts).
const PORT = 8552
const RPC = `http://127.0.0.1:${PORT}`
const EXECUTOR = '0x00000000000000000000000000000000000e7ec0'
const GAS = 100_000n
const FEE = GAS * 10_000_000_000n
const PRIORITY = 1_000_000_000n

/** Anvil's published development keys; each test runs as its own account on the shared chain. */
const KEYS: readonly Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
]

const hasAnvil = spawnSync('anvil', ['--version']).status === 0

const client = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) }).extend(
  publicActions
)

const toBlock = (b: {
  number: bigint | null
  hash: Hex | null
  parentHash: Hex
  timestamp: bigint
}): Block => ({
  number: Number(b.number),
  hash: b.hash!,
  parentHash: b.parentHash,
  timestamp: b.timestamp
})

const encode = (payload: TxPayload) => payload.data as Hex

const chainFor = (account: PrivateKeyAccount): KernelChain => ({
  latest: async () => {
    const [head, finalized] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.getBlock({ blockTag: 'finalized' })
    ])
    return {
      head: toBlock(head),
      finalized: { number: Number(finalized.number), timestamp: finalized.timestamp }
    }
  },
  block: async number => toBlock(await client.getBlock({ blockNumber: BigInt(number) })),
  nonceAt: async at => ({
    latest: await client.getTransactionCount({
      address: account.address,
      blockNumber: BigInt(at.number)
    }),
    pending: await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  }),
  accountCode: async () => (await client.getCode({ address: account.address })) ?? '0x',
  receipt: async hash => {
    try {
      const r = await client.getTransactionReceipt({ hash: hash as Hex })
      return { block: Number(r.blockNumber), blockHash: r.blockHash, status: r.status, logs: [] }
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null
      throw error
    }
  },
  nonceTx: async nonce => {
    const { number: latest } = await client.getBlock({ blockTag: 'latest' })
    for (let n = latest; n >= 0n; n--) {
      const block = await client.getBlock({ blockNumber: n, includeTransactions: true })
      const tx = block.transactions.find(
        t => t.from === account.address.toLowerCase() || t.from === account.address
      )
      if (!tx || tx.nonce !== nonce) continue
      const r = await client.getTransactionReceipt({ hash: tx.hash })
      return { hash: tx.hash, block: Number(n), blockHash: block.hash, status: r.status, logs: [] }
    }
    return null
  },
  commitment: () => Promise.reject(new Error('no commitments on this chain')),
  capacity: () => Promise.reject(new Error('no observed resources'))
})

const effectsFor = (account: PrivateKeyAccount): KernelEffects => ({
  materialize: () => Promise.reject(new Error('nothing to materialize')),
  simulate: async (payload, at) => {
    try {
      await client.call({
        account: account.address,
        to: payload.to as Hex,
        data: encode(payload),
        value: payload.value,
        blockNumber: BigInt(at.number)
      })
      return true
    } catch {
      return false
    }
  },
  signTx: async (payload, { nonce, fee }) => {
    const raw = await account.signTransaction({
      chainId: foundry.id,
      type: 'eip1559',
      to: payload.to as Hex,
      data: encode(payload),
      value: payload.value,
      nonce,
      gas: GAS,
      maxFeePerGas: fee / GAS,
      maxPriorityFeePerGas: PRIORITY
    })
    return { hash: keccak256(raw), raw }
  },
  signTyped: () => Promise.reject(new Error('no typed data here')),
  broadcast: async (raw, guard) => {
    if (!guard.mayAct()) throw new Error('withdrawn before sending')
    try {
      await client.sendRawTransaction({ serializedTransaction: raw as Hex })
      return 'accepted'
    } catch (error) {
      return error instanceof RpcError && !/already known/i.test(error.details)
        ? 'rejected'
        : 'unknown'
    }
  },
  release: () => Promise.reject(new Error('no offchain releases here'))
})

const configFor = (account: PrivateKeyAccount): KernelConfig => ({
  chainId: foundry.id,
  account: account.address,
  validators: [noCommitmentsValidator(EXECUTOR)],
  policy: { targets: [EXECUTOR], recoveryTargets: [account.address] },
  caps: { native: 100n * FEE },
  observedResources: [],
  feeReserve: FEE,
  feePolicy: () => FEE,
  maxSimLagBlocks: 2,
  maxEvidenceAgeBlocks: 64,
  stuckBlocks: 2,
  latchBoundBlocks: 3,
  recoveryBoundMs: 60_000,
  revokeAfterStaleMs: 3_600_000,
  maxRecoveryAttempts: 3,
  maxDispatchLagMs: 5_000
})

const liquidation = (basisBlock: number): PlanInput => ({
  intentId: 'liq:K1',
  steps: [
    {
      kind: 'tx',
      payload: encodeCall(EXECUTOR, 'exec', { tag: 'K1' })
    }
  ],
  notAfter: Date.now() + 600_000,
  basisBlock
})

/** A promise that never settles, standing in for an effect the crash interrupted. */
const never = <T>() => new Promise<T>(() => undefined)

const until = async (done: () => boolean | Promise<boolean>, what: string, mine = false) => {
  const deadline = Date.now() + 20_000
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    if (mine) await client.mine({ blocks: 1 })
    await sleep(20)
  }
}

describe.skipIf(!hasAnvil)(
  'the kernel hosted on the engine against a local chain, killed at each crash boundary',
  { timeout: 30_000 },
  () => {
    let anvil: ChildProcess | undefined
    let directory: string

    beforeAll(async () => {
      anvil = spawn('anvil', ['--port', String(PORT), '--slots-in-an-epoch', '1'], {
        stdio: 'ignore'
      })
      await until(
        () =>
          client.getChainId().then(
            () => true,
            () => false
          ),
        'anvil'
      )
      directory = await mkdtemp(join(tmpdir(), 'kernel-host-'))
    })

    afterAll(async () => {
      anvil?.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    })

    /** The kernel on its own runner, seen through the surface its traces drive. */
    const run = async (
      account: PrivateKeyAccount,
      store: LedgerStore,
      enrollment: 'enrolled' | 'enrolling',
      effects: KernelEffects = effectsFor(account)
    ) => {
      const { runner, nodes, stopped } = await startKernel({
        config: configFor(account),
        store,
        chain: chainFor(account),
        effects,
        enrollment,
        pollMs: 20,
        effectTimeoutMs: 5_000,
        reorgDepth: 64,
        onError: () => {},
        journal: {
          sink: { append: async () => undefined, finalize: async () => undefined },
          capacityBytes: 1_000_000
        }
      })
      return {
        send: (event: RawRequest) => runner.push(unauthored(nodes.requests), event),
        state: () => structuredClone(runner.read(nodes.state)!),
        stopped,
        abandon: runner.abandon
      }
    }

    /** Runs to `running`, submits one liquidation with `effects` interrupted where the test says, then kills it. */
    const crashDuring = async (
      key: Hex,
      interrupt: (effects: KernelEffects, reached: () => void) => KernelEffects,
      store: (
        path: string,
        reached: () => void,
        onDeath: (die: () => void) => void
      ) => LedgerStore = path => createLedgerStore(path)
    ) => {
      const account = privateKeyToAccount(key)
      const path = join(directory, `${account.address}.json`)
      let reached = () => {}
      const crashed = new Promise<void>(resolve => {
        reached = resolve
      })
      const deaths: (() => void)[] = []
      const driver = await run(
        account,
        store(
          path,
          () => reached(),
          die => deaths.push(die)
        ),
        'enrolling',
        interrupt(effectsFor(account), () => reached())
      )
      await until(() => driver.state().lifecycle.kind === 'running', 'running')
      driver.send({
        type: 'Submit',
        plan: liquidation(Number((await client.getBlock({ blockTag: 'latest' })).number))
      })
      await crashed
      const abandoning = driver.abandon()
      for (const die of deaths) die()
      await abandoning
      return { account, path }
    }

    const restart = async (account: PrivateKeyAccount, path: string) =>
      run(account, createLedgerStore(path), 'enrolled')

    it('before any signature: nothing is durable and the nonce is reused', async () => {
      const { account, path } = await crashDuring(KEYS[0]!, (effects, reached) => ({
        ...effects,
        simulate: () => {
          reached()
          return never()
        }
      }))
      const driver = await restart(account, path)
      await until(() => driver.state().lifecycle.kind === 'running', 'running after restart')
      expect(driver.state().nonces).toEqual({})
      expect(driver.state().nextNonce).toBe(0)
      await driver.abandon()
    })

    it('after the commit point but before the flush lands: nothing left the process', async () => {
      const { account, path } = await crashDuring(
        KEYS[1]!,
        effects => effects,
        (path, reached, onDeath) => {
          const store = createLedgerStore(path)
          return {
            read: () => store.read(),
            write: ledger => {
              if (Object.keys(ledger.nonces).length === 0) return store.write(ledger)
              reached()
              return new Promise<void>((_, reject) => {
                onDeath(() => reject(new Error('the process died before this write landed')))
              })
            }
          }
        }
      )
      const driver = await restart(account, path)
      await until(() => driver.state().lifecycle.kind === 'running', 'running after restart')
      expect(driver.state().nonces).toEqual({})
      expect(await client.getTransactionCount({ address: account.address })).toBe(0)
      await driver.abandon()
    })

    it('after the flush lands but before the broadcast: latched, then the nonce is filled in recovery', async () => {
      const { account, path } = await crashDuring(KEYS[2]!, (effects, reached) => ({
        ...effects,
        broadcast: () => {
          reached()
          return never()
        }
      }))
      const driver = await restart(account, path)
      await until(() => driver.state().nonces[0] !== undefined, 'the stored record')
      expect(driver.state().nonces[0]?.candidates[0]?.sent).toBe('unknown')
      const report = await Promise.race([
        driver.stopped,
        until(() => false, 'a stop', true).then(() => undefined)
      ])
      expect(report).toMatchObject({ outcome: 'clean' })
      expect(await client.getTransactionCount({ address: account.address })).toBe(1)
      const filled = await chainFor(account).nonceTx(0)
      const tx = await client.getTransaction({ hash: filled!.hash as Hex })
      expect(tx.to?.toLowerCase()).toBe(account.address.toLowerCase())
    })

    it('after the broadcast but before its result: a restart resolves it from the chain', async () => {
      const { account, path } = await crashDuring(KEYS[3]!, (effects, reached) => ({
        ...effects,
        broadcast: async (raw, guard) => {
          await effects.broadcast(raw, guard)
          reached()
          return never()
        }
      }))
      await client.mine({ blocks: 5 })
      const driver = await restart(account, path)
      await until(
        () =>
          driver.state().lifecycle.kind === 'running' &&
          Object.keys(driver.state().nonces).length === 0,
        'the record resolved after restart',
        true
      )
      expect(driver.state().nextNonce).toBe(1)
      await driver.abandon()
    })
  }
)
