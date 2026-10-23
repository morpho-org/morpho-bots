import type { Hex, LocalAccount } from 'viem'

import {
  createPublicClient,
  custom,
  http,
  HttpRequestError,
  InternalRpcError,
  RpcError,
  serializeTransaction
} from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { Signer } from '../src/signer'

import { createKernelEffects } from '../src/kernel-effects'

const raw: Hex = serializeTransaction(
  {
    type: 'eip1559',
    chainId: 1,
    nonce: 0,
    to: '0x0000000000000000000000000000000000000002',
    data: '0x',
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n
  },
  { r: '0x01', s: '0x01', yParity: 0 }
)

const effectsBroadcasting = (failure: unknown) =>
  createKernelEffects({
    client: createPublicClient({ transport: http('http://127.0.0.1:1') }),
    signer: {
      account: { address: '0x0000000000000000000000000000000000000001' },
      broadcastRaw: () => Promise.reject(failure)
    } as unknown as Signer,
    maxFeePerGasWei: 1n,
    priorityFeePerGasWei: 1n,
    maxGasLimit: 1n,
    materialize: () => Promise.reject(new Error('none'))
  })

const guard = { signal: new AbortController().signal, mayAct: () => true }

/** A JSON-RPC error as viem raises it from a node's answer. */
const answer = (code: number, message: string) =>
  new RpcError(Object.assign(new Error(message), { details: message }), {
    code,
    shortMessage: message
  })

describe('kernel broadcasts', () => {
  it('reads only a node refusing to pool these bytes as rejected, whatever the error code says', async () => {
    for (const refusal of [
      'replacement transaction underpriced',
      'insufficient funds for gas * price + value',
      'max fee per gas less than block base fee'
    ])
      expect(await effectsBroadcasting(answer(-32000, refusal)).broadcast(raw, guard)).toBe(
        'rejected'
      )
    for (const ambiguous of [
      answer(-32000, 'nonce too low'),
      answer(-32000, 'AlreadyKnown'),
      answer(-32000, 'internal server error'),
      answer(-32003, 'transaction rejected'),
      new InternalRpcError(new Error('upstream')),
      new HttpRequestError({ url: 'http://127.0.0.1:1', status: 502 }),
      new TypeError('socket hang up')
    ])
      expect(await effectsBroadcasting(ambiguous).broadcast(raw, guard)).toBe('unknown')
  })
})

describe('kernel signing', () => {
  it('asks the guard just before signing, and signs nothing it refuses', async () => {
    const signTypedData = vi.fn(() => Promise.resolve('0x01'))
    const effects = createKernelEffects({
      client: createPublicClient({ transport: http('http://127.0.0.1:1') }),
      signer: {
        account: { address: '0x0000000000000000000000000000000000000001' }
      } as unknown as Signer,
      typedSigner: { signTypedData } as unknown as LocalAccount,
      maxFeePerGasWei: 1n,
      priorityFeePerGasWei: 1n,
      maxGasLimit: 1n,
      materialize: () => Promise.reject(new Error('none'))
    })
    const typed = {
      kind: 'typed' as const,
      domain: {},
      types: {},
      primaryType: 'Root',
      message: {}
    }
    await expect(effects.signTyped(typed, { ...guard, mayAct: () => false })).rejects.toThrow(
      'withdrawn'
    )
    expect(signTypedData).not.toHaveBeenCalled()
    expect(await effects.signTyped(typed, guard)).toBe('0x01')
  })
})

describe('kernel transaction signing', () => {
  const GAS = 100n
  const FROM = '0x0000000000000000000000000000000000000001'
  const TO = '0x0000000000000000000000000000000000000002'

  const signing = (
    maxFeePerGasWei = 1_000n,
    estimatedGas = GAS,
    maxGasLimit = 1_000n,
    baseFees: readonly bigint[] = [10n]
  ) => {
    let baseFeeIndex = 0
    const sign = vi.fn<Signer['sign']>(async request => {
      const signedRaw = serializeTransaction(
        {
          type: 'eip1559',
          chainId: 1,
          nonce: request.nonce,
          to: request.to,
          data: request.data,
          value: request.value,
          gas: request.gas,
          maxFeePerGas: request.maxFeePerGas,
          maxPriorityFeePerGas: request.maxPriorityFeePerGas
        },
        { r: '0x01', s: '0x01', yParity: 0 }
      )
      return {
        nonce: request.nonce,
        txHash: '0xaa' as Hex,
        raw: signedRaw as Hex,
        gas: request.gas!
      }
    })
    const broadcastRaw = vi.fn(() => Promise.resolve({}))
    const effects = createKernelEffects({
      client: createPublicClient({
        transport: custom({
          request: ({ method }) =>
            method === 'eth_estimateGas'
              ? Promise.resolve(`0x${estimatedGas.toString(16)}`)
              : Promise.reject(new Error(`unexpected ${method}`))
        })
      }),
      signer: {
        account: { address: FROM },
        getBaseFee: () => Promise.resolve(baseFees[Math.min(baseFeeIndex++, baseFees.length - 1)]!),
        sign,
        broadcastRaw
      } as unknown as Signer,
      maxFeePerGasWei,
      priorityFeePerGasWei: 2n,
      maxGasLimit,
      materialize: () => Promise.reject(new Error('none'))
    })
    return { effects, sign, broadcastRaw }
  }

  it("leaves the kernel's guard to the signer, which asks it only once it is about to sign", async () => {
    const { effects, sign } = signing()
    const mayAct = vi.fn(() => false)
    let askedBeforeSigner = -1
    sign.mockImplementation(request => {
      askedBeforeSigner = mayAct.mock.calls.length
      return request.mayAct?.()
        ? Promise.resolve({ nonce: request.nonce, txHash: '0xaa', raw: '0xbb', gas: GAS })
        : Promise.reject(new Error('withdrawn'))
    })
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    await expect(
      effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 1 }, { ...guard, mayAct })
    ).rejects.toThrow('withdrawn')
    expect(askedBeforeSigner).toBe(0)
    expect(mayAct).toHaveBeenCalledOnce()
  })

  it('refuses to sign a payload carrying value', async () => {
    const { effects, sign } = signing()
    await expect(
      effects.signTx(
        { kind: 'tx' as const, to: TO, data: '0x', value: 1n },
        { nonce: 0, fee: 1_000n * GAS, level: 1 },
        guard
      )
    ).rejects.toThrow('the kernel signer sends no value')
    expect(sign).not.toHaveBeenCalled()
  })

  it('bids a first candidate from the base fee and a replacement of unknown fees at the full ceiling', async () => {
    const { effects, sign } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 1 }, guard)
    await effects.signTx(payload, { nonce: 8, fee: 500n * GAS, level: 2 }, guard)
    expect(sign.mock.calls.map(([request]) => request)).toStrictEqual([
      {
        to: TO,
        data: '0x',
        value: 0n,
        maxFeePerGas: 22n,
        maxPriorityFeePerGas: 2n,
        nonce: 7,
        gas: 120n,
        mayAct: expect.any(Function)
      },
      {
        to: TO,
        data: '0x',
        value: 0n,
        maxFeePerGas: 500n,
        maxPriorityFeePerGas: 500n,
        nonce: 8,
        gas: GAS,
        mayAct: expect.any(Function)
      }
    ])
  })

  it("outbids the candidate it replaces when that candidate's fees are known", async () => {
    const { effects, sign } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    const first = await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 1 }, guard)
    await effects.broadcast(first.raw, guard)
    await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 2 }, guard)
    expect(sign.mock.calls.map(([request]) => request)).toStrictEqual([
      {
        to: TO,
        data: '0x',
        value: 0n,
        maxFeePerGas: 22n,
        maxPriorityFeePerGas: 2n,
        nonce: 7,
        gas: 120n,
        mayAct: expect.any(Function)
      },
      {
        to: TO,
        data: '0x',
        value: 0n,
        maxFeePerGas: 24n,
        maxPriorityFeePerGas: 3n,
        nonce: 7,
        gas: 120n,
        mayAct: expect.any(Function)
      }
    ])
  })

  it('refuses a replacement that cannot bump known fees within the same ceiling', async () => {
    const { effects, sign } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    const first = await effects.signTx(payload, { nonce: 7, fee: 22n * GAS, level: 1 }, guard)
    await effects.broadcast(first.raw, guard)
    await expect(
      effects.signTx(payload, { nonce: 7, fee: 22n * GAS, level: 2 }, guard)
    ).rejects.toThrow('cannot outbid the known candidate')
    expect(sign).toHaveBeenCalledOnce()
  })

  it('refuses a replacement below the known bid when its current per-gas ceiling falls', async () => {
    const { effects, sign } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    const first = await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 1 }, guard)
    await effects.broadcast(first.raw, guard)
    await expect(
      effects.signTx(payload, { nonce: 7, fee: 20n * GAS, level: 2 }, guard)
    ).rejects.toThrow('cannot outbid the known candidate')
    expect(sign).toHaveBeenCalledOnce()
  })

  it('caps optional headroom when the base fee rises between a known bid and its replacement', async () => {
    const { effects, sign } = signing(100n, GAS, 1_000n, [10n, 60n])
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    const first = await effects.signTx(payload, { nonce: 7, fee: 100n * GAS, level: 1 }, guard)
    await effects.broadcast(first.raw, guard)
    await effects.signTx(payload, { nonce: 7, fee: 100n * GAS, level: 2 }, guard)
    expect(sign).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxFeePerGas: 100n, maxPriorityFeePerGas: 3n })
    )
  })

  it('does not remember a signed bid that dispatch withdraws before broadcast', async () => {
    const { effects, sign, broadcastRaw } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    const first = await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 1 }, guard)
    await expect(effects.broadcast(first.raw, { ...guard, mayAct: () => false })).rejects.toThrow(
      'withdrawn'
    )
    await effects.signTx(payload, { nonce: 7, fee: 500n * GAS, level: 2 }, guard)
    expect(broadcastRaw).not.toHaveBeenCalled()
    expect(sign).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxFeePerGas: 500n, maxPriorityFeePerGas: 500n })
    )
  })

  it('pads estimated gas by 20% and caps that headroom at the candidate spend ceiling', async () => {
    const { effects, sign } = signing()
    const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
    await effects.signTx(payload, { nonce: 7, fee: 2_300n, level: 1 }, guard)
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: 104n, maxFeePerGas: 22n }))
    expect(104n * 22n <= 2_300n).toBe(true)
  })

  it.each([
    { name: 'the signer policy', to: TO, estimatedGas: GAS, maxGasLimit: 110n, expected: 110n },
    {
      name: 'the nonce-fill policy',
      to: FROM,
      estimatedGas: 90_000n,
      maxGasLimit: 1n,
      expected: 100_000n
    }
  ])('caps gas padding at $name limit', async ({ to, estimatedGas, maxGasLimit, expected }) => {
    const { effects, sign } = signing(1_000n, estimatedGas, maxGasLimit)
    await effects.signTx(
      { kind: 'tx', to, data: '0x', value: 0n },
      { nonce: 7, fee: 500n * estimatedGas, level: 1 },
      guard
    )
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: expected }))
  })

  it('keeps an estimate exactly at the signer policy gas limit', async () => {
    const { effects, sign } = signing(1_000n, GAS, GAS)
    await effects.signTx(
      { kind: 'tx', to: TO, data: '0x', value: 0n },
      { nonce: 7, fee: 500n * GAS, level: 1 },
      guard
    )
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: GAS }))
  })

  it.each([
    {
      name: 'the candidate fee rounds below one wei per gas',
      maxFeePerGasWei: 1_000n,
      fee: GAS - 1n
    },
    { name: 'the configured per-gas ceiling is zero', maxFeePerGasWei: 0n, fee: 1_000n * GAS }
  ])('refuses to sign when $name', async ({ maxFeePerGasWei, fee }) => {
    const { effects, sign } = signing(maxFeePerGasWei)
    await expect(
      effects.signTx(
        { kind: 'tx', to: TO, data: '0x', value: 0n },
        { nonce: 7, fee, level: 1 },
        guard
      )
    ).rejects.toThrow('cannot fund a positive per-gas bid')
    expect(sign).not.toHaveBeenCalled()
  })
})
