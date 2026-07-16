import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { createClient, custom, decodeFunctionData, encodeAbiParameters, getAddress } from 'viem'

import type { QuoteLogger } from '../../src/quoting'

import { createErc4626Unwrapper, ERC4626_SHARES_OFFSET } from '../../src/unwrappers/erc4626'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

const VAULT = getAddress('0x4444444444444444444444444444444444444444')
const ASSET = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

const ASSET_SELECTOR = '0x38d52e0f' // asset()
const PREVIEW_SELECTOR = '0x4cdad506' // previewRedeem(uint256)

const redeemAbi = [
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const

// A viem client over a custom transport that dispatches eth_call by function selector — the real
// encode/request/decode path runs, only the node is faked. Handlers may return result hex or throw.
function fakeChain(handlers: { asset: () => Hex; previewRedeem?: () => Hex }) {
  const calls: { selector: string }[] = []
  const client = createClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
          const [{ data }] = params as [{ data: Hex }]
          const selector = data.slice(0, 10)
          calls.push({ selector })
          if (selector === ASSET_SELECTOR) return handlers.asset()
          if (selector === PREVIEW_SELECTOR && handlers.previewRedeem)
            return handlers.previewRedeem()
          throw new Error(`unexpected selector ${selector}`)
        }
      },
      // No transport-level retries: the tests count eth_calls to prove memoization.
      { retryCount: 0 }
    )
  })
  return { client, calls }
}

const assetResult = encodeAbiParameters([{ type: 'address' }], [ASSET])
const previewResult = (out: bigint) => encodeAbiParameters([{ type: 'uint256' }], [out])

// How a node reports a data-less revert (e.g. calling asset() on a plain ERC20): an RPC error viem
// maps to ExecutionRevertedError — a contract-level failure, safe to memoize as "not a vault".
const revert = () => {
  throw { code: 3, message: 'execution reverted' }
}

describe('createErc4626Unwrapper', () => {
  it('resolves a vault into a balance-spliced redeem step with the previewed output', async () => {
    const { client } = fakeChain({
      asset: () => assetResult,
      previewRedeem: () => previewResult(2000n)
    })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })

    const result = await unwrapper.resolve({ token: VAULT, amountIn: 1000n, executor: EXECUTOR })
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.expectedAmountOut).toBe(2000n)
    expect(result.amountOutMinimum).toBe(2000n)
    expect(result.step).toMatchObject({
      tokenIn: VAULT,
      tokenOut: ASSET,
      target: VAULT,
      value: 0n,
      amountIn: { source: 'balance', offset: ERC4626_SHARES_OFFSET }
    })
    expect(result.step.approvalSpender).toBeUndefined()

    // The calldata is redeem(shares, executor, executor) — the shares word (spliced at exec time)
    // sits at byte offset 4, right after the selector.
    const decoded = decodeFunctionData({ abi: redeemAbi, data: result.step.callData })
    expect(decoded.functionName).toBe('redeem')
    expect(decoded.args).toEqual([1000n, EXECUTOR, EXECUTOR])
    expect(ERC4626_SHARES_OFFSET).toBe(4n)
  })

  it('memoizes a contract-level asset() failure as not-a-vault (one probe, ever)', async () => {
    const { client, calls } = fakeChain({ asset: revert })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })

    expect(await unwrapper.resolve({ token: VAULT, amountIn: 1n, executor: EXECUTOR })).toBeNull()
    expect(await unwrapper.resolve({ token: VAULT, amountIn: 1n, executor: EXECUTOR })).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('rethrows a transport-level asset() failure and does NOT memoize it', async () => {
    let healthy = false
    const { client, calls } = fakeChain({
      asset: () => {
        if (!healthy) throw new Error('connection refused')
        return assetResult
      },
      previewRedeem: () => previewResult(2000n)
    })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })

    expect(unwrapper.resolve({ token: VAULT, amountIn: 1n, executor: EXECUTOR })).rejects.toThrow()

    // The outage was not cached as "not a vault": once the RPC recovers, the same token resolves.
    healthy = true
    const result = await unwrapper.resolve({ token: VAULT, amountIn: 1000n, executor: EXECUTOR })
    expect(result?.step.tokenOut).toBe(ASSET)
    expect(calls.filter(call => call.selector === ASSET_SELECTOR).length).toBeGreaterThan(1)
  })

  it('treats a previewRedeem revert as not-a-vault (ERC-7540 async vaults)', async () => {
    const { client } = fakeChain({ asset: () => assetResult, previewRedeem: revert })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })
    expect(
      await unwrapper.resolve({ token: VAULT, amountIn: 1000n, executor: EXECUTOR })
    ).toBeNull()
  })

  it('treats a zero previewRedeem as not-a-vault', async () => {
    const { client } = fakeChain({
      asset: () => assetResult,
      previewRedeem: () => previewResult(0n)
    })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })
    expect(
      await unwrapper.resolve({ token: VAULT, amountIn: 1000n, executor: EXECUTOR })
    ).toBeNull()
  })

  it('treats a self-referential asset() as not-a-vault', async () => {
    const { client } = fakeChain({
      asset: () => encodeAbiParameters([{ type: 'address' }], [VAULT])
    })
    const unwrapper = createErc4626Unwrapper({ client, logger: NOOP_LOGGER })
    expect(
      await unwrapper.resolve({ token: VAULT, amountIn: 1000n, executor: EXECUTOR })
    ).toBeNull()
  })
})
