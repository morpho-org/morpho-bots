import type { TxBid } from '@repo/kernel'
import type { Hex, LocalAccount } from 'viem'

import { mulDivDown } from '@repo/utils'
import {
  createPublicClient,
  custom,
  http,
  HttpRequestError,
  InternalRpcError,
  parseGwei,
  RpcError,
  serializeTransaction
} from 'viem'
import { base } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'

import type { Signer } from '../src/signer'

import { blockTimeMs } from '../src/block-time'
import { createKernelEffects, firstBid, gasLimitFor } from '../src/kernel-effects'
import { NONCE_FILL_MAX_GAS } from '../src/policy'

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

  it('reads only the whole "already known" answer as accepted', async () => {
    expect(await effectsBroadcasting(answer(-32000, 'already known')).broadcast(raw, guard)).toBe(
      'accepted'
    )
    for (const misleading of [
      'nonce already known',
      'already known in a failed cache',
      'transaction already imported into failed cache',
      `already known: ${'0x'.padEnd(66, '0')}`
    ])
      expect(await effectsBroadcasting(answer(-32000, misleading)).broadcast(raw, guard)).toBe(
        'unknown'
      )
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
    baseFees: readonly bigint[] = [10n],
    rewards?: readonly bigint[] | 'fails' | 'stalls'
  ) => {
    let baseFeeIndex = 0
    const warnings: string[] = []
    let historyReads = 0
    const feeHistory = () => {
      historyReads += 1
      if (rewards === 'stalls') return new Promise(() => {})
      if (rewards === undefined || rewards === 'fails')
        return Promise.reject(new Error('eth_feeHistory unavailable'))
      return Promise.resolve({
        oldestBlock: '0x1',
        baseFeePerGas: [...rewards, 0n].map(() => '0xa'),
        gasUsedRatio: rewards.map(() => 0.5),
        reward: rewards.map(tip => [`0x${tip.toString(16)}`])
      })
    }
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
        chain: base,
        transport: custom({
          request: ({ method }) =>
            method === 'eth_estimateGas'
              ? Promise.resolve(`0x${estimatedGas.toString(16)}`)
              : method === 'eth_feeHistory'
                ? feeHistory()
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
      maxGasLimit,
      materialize: () => Promise.reject(new Error('none')),
      logger: {
        debug: () => {},
        info: () => {},
        warn: event => warnings.push(event),
        error: () => {}
      }
    })
    return { effects, sign, broadcastRaw, warnings, historyReads: () => historyReads }
  }

  const payload = { kind: 'tx' as const, to: TO, data: '0x', value: 0n }
  /** A step under a fee ceiling of 1,000 wei per gas, whose step cap is 889. */
  const bid = (overrides: Partial<TxBid> = {}): TxBid => ({
    nonce: 7,
    level: 1,
    kind: 'step',
    fee: 500n * GAS,
    recoveryFee: 1_000n * NONCE_FILL_MAX_GAS,
    ...overrides
  })
  const fill = (overrides: Partial<TxBid>) => bid({ kind: 'fill', fee: 1_000n * GAS, ...overrides })
  const outbid = (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) => ({
    outbid: { maxFeePerGas, maxPriorityFeePerGas },
    level: 2
  })

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
    await expect(effects.signTx(payload, bid(), { ...guard, mayAct })).rejects.toThrow('withdrawn')
    expect(askedBeforeSigner).toBe(0)
    expect(mayAct).toHaveBeenCalledOnce()
  })

  it('refuses to sign a payload carrying value', async () => {
    const { effects, sign } = signing()
    await expect(effects.signTx({ ...payload, value: 1n }, bid(), guard)).rejects.toThrow(
      'the kernel signer sends no value'
    )
    expect(sign).not.toHaveBeenCalled()
  })

  it('bids a first candidate from the base fee and reports what it signed', async () => {
    const { effects, sign } = signing()
    expect(await effects.signTx(payload, bid(), guard)).toMatchObject({
      bid: { maxFeePerGas: 145n, maxPriorityFeePerGas: 125n, gas: 120n }
    })
    expect(sign.mock.calls.map(([request]) => request)).toStrictEqual([
      {
        to: TO,
        data: '0x',
        value: 0n,
        maxFeePerGas: 145n,
        maxPriorityFeePerGas: 125n,
        nonce: 7,
        gas: 120n,
        mayAct: expect.any(Function)
      }
    ])
  })

  it('outbids the highest fees recorded at the nonce', async () => {
    const { effects, sign } = signing()
    await effects.signTx(payload, bid(outbid(22n, 2n)), guard)
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: 24n, maxPriorityFeePerGas: 3n, nonce: 7 })
    )
  })

  it('stops a step one bump below the fee ceiling, where a fill can still outbid it', async () => {
    const { effects, sign } = signing()
    expect(await effects.signTx(payload, bid(outbid(889n, 2n)), guard)).toBe('capped')
    expect(sign).not.toHaveBeenCalled()
    await effects.signTx(payload, fill(outbid(889n, 2n)), guard)
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ maxFeePerGas: 1_000n }))
  })

  it('funds a replacement fill at the fee ceiling even when its estimate reaches the fill gas bound', async () => {
    const { effects, sign } = signing(1_000n, NONCE_FILL_MAX_GAS)
    const fillPayload = { ...payload, to: FROM }
    await effects.signTx(
      fillPayload,
      fill({ ...outbid(889n, 2n), fee: 1_000n * NONCE_FILL_MAX_GAS }),
      guard
    )
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: 1_000n, gas: NONCE_FILL_MAX_GAS })
    )
  })

  it('caps a fill at the fee ceiling', async () => {
    const { effects, sign } = signing()
    expect(await effects.signTx(payload, fill(outbid(1_000n, 2n)), guard)).toBe('capped')
    expect(sign).not.toHaveBeenCalled()
  })

  it('caps a replacement at its own spend bound', async () => {
    const { effects, sign } = signing()
    expect(await effects.signTx(payload, bid({ ...outbid(22n, 2n), fee: 22n * GAS }), guard)).toBe(
      'capped'
    )
    expect(sign).not.toHaveBeenCalled()
  })

  it('clamps a first step bid under a high base fee to the step cap the recovery bound sets', async () => {
    const { effects, sign } = signing(1_000n, GAS, 1_000n, [60n])
    await effects.signTx(payload, bid({ recoveryFee: 50n * NONCE_FILL_MAX_GAS }), guard)
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: 45n, maxPriorityFeePerGas: 12n })
    )
  })

  it('caps optional headroom at the step cap when the base fee rises', async () => {
    const { effects, sign } = signing(100n, GAS, 1_000n, [60n])
    await effects.signTx(payload, bid(outbid(22n, 2n)), guard)
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: 89n, maxPriorityFeePerGas: 3n })
    )
  })

  it('pads estimated gas by 20% and caps that headroom at the candidate spend ceiling', async () => {
    const { effects, sign } = signing()
    await effects.signTx(payload, bid({ fee: 2_300n }), guard)
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: 100n, maxFeePerGas: 23n }))
  })

  it('signs the first bid firstBid prices, so a gate on its gas holds at the signer', async () => {
    const estimatedGas = 100_000n
    for (const { fee, maxGasLimit, gas } of [
      { fee: 2_520_000n, maxGasLimit: 1_000_000n, gas: 120_000n },
      { fee: 1_285_714n, maxGasLimit: 1_000_000n, gas: 107_142n },
      { fee: 2_310_000n, maxGasLimit: 110_000n, gas: 110_000n }
    ]) {
      const expected = firstBid({
        fee,
        estimatedGas,
        baseFee: 7n,
        maxFeePerGas: 1_000n,
        gasLimit: gasLimitFor(estimatedGas, maxGasLimit)
      })
      expect(expected.gas).toBe(gas)
      const { effects } = signing(1_000n, estimatedGas, maxGasLimit, [7n])
      expect(await effects.signTx(payload, bid({ fee }), guard)).toMatchObject({ bid: expected })
    }
  })

  describe('the first tip', () => {
    const tipOf = async (rewards?: readonly bigint[] | 'fails') => {
      const harness = signing(1_000n, GAS, 1_000n, [10n], rewards)
      const signed = await harness.effects.signTx(payload, bid(), guard)
      if (typeof signed === 'string') throw new Error(signed)
      return { tip: signed.bid.maxPriorityFeePerGas, ...harness }
    }

    it("is the median of recent blocks' high-percentile tips, under the quarter of its cap", async () => {
      expect((await tipOf([9n, 3n, 300n, 5n, 7n])).tip).toBe(7n)
      expect((await tipOf([1_000n, 900n, 800n])).tip).toBe(125n)
      expect((await tipOf([0n, 0n, 20n, 20n])).tip).toBe(10n)
    })

    it('is at least 1 wei when recent blocks tipped nothing', async () => {
      expect((await tipOf([0n, 0n, 0n])).tip).toBe(1n)
    })

    it('falls back to a quarter of its cap, warning once, when the node serves no tips', async () => {
      for (const rewards of ['fails', []] as const) {
        vi.spyOn(Date, 'now').mockReturnValue(0)
        const { tip, effects, warnings, historyReads } = await tipOf(rewards)
        expect(tip).toBe(125n)
        const firstReads = historyReads()
        vi.spyOn(Date, 'now').mockReturnValue(blockTimeMs(base.id))
        await effects.signTx(payload, bid({ nonce: 8 }), guard)
        expect(historyReads()).toBeGreaterThan(firstReads)
        expect(warnings).toHaveLength(1)
        vi.restoreAllMocks()
      }
    })

    it('falls back to a quarter of its cap well before a bid deadline when fee history stalls', async () => {
      vi.useFakeTimers()
      const { effects } = signing(1_000n, GAS, 1_000n, [10n], 'stalls')
      const signed = effects.signTx(payload, bid(), guard)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await signed).toMatchObject({ bid: { maxPriorityFeePerGas: 125n } })
      vi.useRealTimers()
    })

    it('shares one read among first bids that wait on it together', async () => {
      let clock = 0
      vi.spyOn(Date, 'now').mockImplementation(() => (clock += blockTimeMs(base.id)))
      const { effects, historyReads } = signing(1_000n, GAS, 1_000n, [10n], [5n])
      await Promise.all([7, 8, 9].map(nonce => effects.signTx(payload, bid({ nonce }), guard)))
      expect(historyReads()).toBe(1)
      vi.restoreAllMocks()
    })

    it('reads fee history at most once per block time', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(0)
      const { effects, historyReads } = await tipOf([5n])
      await effects.signTx(payload, bid({ nonce: 8 }), guard)
      expect(historyReads()).toBe(1)
      vi.spyOn(Date, 'now').mockReturnValue(blockTimeMs(base.id))
      await effects.signTx(payload, bid({ nonce: 9 }), guard)
      expect(historyReads()).toBe(2)
      vi.restoreAllMocks()
    })
  })

  it('re-bids a stuck first step under a 0.5 gwei ceiling', async () => {
    const ceiling = parseGwei('0.5')
    const { effects } = signing(ceiling)
    const step = bid({ fee: ceiling * GAS, recoveryFee: ceiling * NONCE_FILL_MAX_GAS })
    const first = await effects.signTx(payload, step, guard)
    if (typeof first === 'string') throw new Error(`first bid ${first}`)
    const rebid = await effects.signTx(
      payload,
      { ...step, ...outbid(first.bid.maxFeePerGas, first.bid.maxPriorityFeePerGas) },
      guard
    )
    expect(rebid).toMatchObject({
      bid: { maxPriorityFeePerGas: mulDivDown(first.bid.maxPriorityFeePerGas, 1125n, 1000n) }
    })
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
    await effects.signTx({ ...payload, to }, bid({ fee: 500n * estimatedGas }), guard)
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: expected }))
  })

  it('keeps an estimate exactly at the signer policy gas limit', async () => {
    const { effects, sign } = signing(1_000n, GAS, GAS)
    await effects.signTx(payload, bid(), guard)
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
    await expect(effects.signTx(payload, bid({ fee }), guard)).rejects.toThrow(
      'cannot fund a positive per-gas bid'
    )
    expect(sign).not.toHaveBeenCalled()
  })
})
