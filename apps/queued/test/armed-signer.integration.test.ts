import type { Logger } from '@repo/evm-kit'
import type { Hex } from 'viem'

import { createRemoteSigner, SignerPolicyError } from '@repo/signer-client'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTransaction } from 'viem'
import { base } from 'viem/chains'

import { createPendingQueue } from '../src/pending-queue'
import { createSender } from '../src/sender'

const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const EXECUTOR = `0x${'22'.repeat(20)}` as const
const HASHES = [`0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`] as const
const NOOP = () => undefined
const LOGGER: Logger = { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP }
const SIGNER_MAIN = join(import.meta.dir, '..', '..', 'signer', 'src', 'main.ts')

type RpcBody = { id: number; method: string; params?: unknown[] }

describe('armed queue with remote signer', () => {
  afterEach(() => mock.restore())

  it('signs an initial send and same-nonce replacement, then preserves policy rejection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'armed-queue-'))
    const socketPath = join(dir, 'signer.sock')
    const signerProcess = Bun.spawn([process.execPath, SIGNER_MAIN], {
      env: {
        ...process.env,
        MORPHO_BOTS_HOME: dir,
        SIGNER_SOCKET: socketPath,
        SIGNER_PRIVATE_KEY: KEY,
        SIGNER_POLICY_JSON: JSON.stringify({
          chainId: base.id,
          executor: EXECUTOR,
          maxFeePerGasWei: '300000000000',
          maxGasLimit: '15000000',
          maxDataBytes: 65536
        })
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })

    try {
      const rawNonces: number[] = []
      const rawMaxFees: bigint[] = []
      let broadcasts = 0
      spyOn(globalThis, 'fetch').mockImplementation((async (
        _url: unknown,
        init?: { body?: string }
      ) => {
        const body = JSON.parse(init?.body ?? '{}') as RpcBody
        let result: unknown
        switch (body.method) {
          case 'eth_chainId':
            result = `0x${base.id.toString(16)}`
            break
          case 'eth_getTransactionCount':
            result = '0x5'
            break
          case 'eth_estimateGas':
            result = '0x5208'
            break
          case 'eth_getBlockByNumber':
            result = { baseFeePerGas: '0x64' }
            break
          case 'eth_getTransactionReceipt':
            result = null
            break
          case 'eth_sendRawTransaction': {
            const transaction = parseTransaction(body.params?.[0] as Hex)
            if (transaction.nonce === undefined) throw new Error('signed transaction lacks nonce')
            rawNonces.push(transaction.nonce)
            rawMaxFees.push(transaction.maxFeePerGas ?? 0n)
            result = HASHES[broadcasts]
            broadcasts += 1
            break
          }
          default:
            throw new Error(`unmocked RPC method ${body.method}`)
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }) as typeof fetch)

      let remoteSigner: Awaited<ReturnType<typeof createRemoteSigner>> | undefined
      const deadline = Date.now() + 8_000
      while (!remoteSigner && Date.now() < deadline) {
        if (existsSync(socketPath)) {
          remoteSigner = await createRemoteSigner({ socketPath }).catch(() => undefined)
        }
        if (!remoteSigner) await Bun.sleep(25)
      }
      if (!remoteSigner) throw new Error('signer process did not become ready')
      const sender = createSender({ chain: base, rpcUrl: 'http://rpc.test', signer: remoteSigner })
      const queue = createPendingQueue({
        ...sender,
        maxFeeWei: 300_000_000_000n,
        stuckBlocks: 1n,
        logger: LOGGER
      })
      const request = { to: EXECUTOR, data: '0x00000001' as Hex, value: 0n }

      await expect(
        queue.submit({
          request,
          label: 'position-1',
          maxFeePerGas: 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
          blockNumber: 0n
        })
      ).resolves.toEqual({ submitted: true, nonce: 5, txHash: HASHES[0] })

      await queue.onBlock(2n)
      expect(rawNonces).toEqual([5, 5])
      expect(rawMaxFees[1]).toBeGreaterThan(rawMaxFees[0] ?? 0n)
      expect(queue.snapshot()).toEqual([{ nonce: 5, txHash: HASHES[1], attempt: 1 }])

      await expect(
        queue.submit({
          request: { ...request, to: `0x${'33'.repeat(20)}` },
          label: 'position-2',
          maxFeePerGas: 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
          blockNumber: 2n
        })
      ).rejects.toBeInstanceOf(SignerPolicyError)
      expect(broadcasts).toBe(2)
    } finally {
      signerProcess.kill('SIGTERM')
      await signerProcess.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
