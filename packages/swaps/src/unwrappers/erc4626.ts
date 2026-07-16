import type { Address, Client } from 'viem'

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
  ExecutionRevertedError,
  isAddressEqual,
  zeroAddress
} from 'viem'
import { readContract } from 'viem/actions'

import type { QuoteLogger } from '../quoting'
import type { Unwrapper } from './resolve'

const erc4626Abi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'previewRedeem',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  },
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

// `redeem(uint256 shares, address receiver, address owner)`: the shares word sits right after the
// 4-byte selector, so splicing the Executor's live share balance there makes the redeem burn
// exactly what arrived — required for midnight's cap-binding branch (seizedAssets is derived
// on-chain) and it absorbs donations to the shared singleton.
export const ERC4626_SHARES_OFFSET = 4n

/**
 * `true` only for a failure the CONTRACT produced (revert, no code / empty return): the one kind
 * of `readContract` error that proves "this token is not an ERC4626 vault" and is safe to memoize.
 * Transport-layer failures (HTTP, timeout, RPC) must NOT be classified here — memoizing one would
 * mislabel a real vault for the process lifetime, so the caller rethrows them instead (→ the
 * existing `failed` outcome + backoff, which recovers).
 */
function isContractLevelFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  return (
    error.walk(
      e =>
        // Revert with decodable data / revert without data (how viem surfaces "plain ERC20 has no
        // asset()") / a successful call that returned no data (address without code).
        e instanceof ContractFunctionRevertedError ||
        e instanceof ExecutionRevertedError ||
        e instanceof ContractFunctionZeroDataError
    ) !== null
  )
}

/**
 * Detects ERC4626 vault shares and converts them into a balance-spliced
 * `redeem(shares, executor, executor)` step (no approval needed — the vault burns the caller's own
 * shares). Detection probes `asset()` (memoized per token, negatives included) and gates on
 * `previewRedeem(amountIn)` succeeding with a non-zero output — which by spec also filters
 * ERC-7540 async vaults (their `previewRedeem` MUST revert) and `asset()` false positives.
 * `previewRedeem` ≤ actual redeem (EIP-4626, same tx), so threading it as the next stage's input
 * amount can only leave skimmable surplus, never a shortfall.
 */
export function createErc4626Unwrapper(deps: { client: Client; logger: QuoteLogger }): Unwrapper {
  const { client, logger } = deps
  // Process-lifetime probe memo (null = confirmed not a vault). Closure state, deliberately not
  // module state — each op run constructs its own unwrapper, mirroring the venue selector.
  const underlyingByToken = new Map<Address, Address | null>()

  async function underlyingFor(token: Address): Promise<Address | null> {
    const cached = underlyingByToken.get(token)
    if (cached !== undefined) return cached

    let underlying: Address | null
    try {
      const asset = await readContract(client, {
        address: token,
        abi: erc4626Abi,
        functionName: 'asset'
      })
      // A self-referential or zero `asset()` is not a redeemable vault.
      underlying = isAddressEqual(asset, zeroAddress) || isAddressEqual(asset, token) ? null : asset
    } catch (error) {
      if (!isContractLevelFailure(error)) throw error
      underlying = null
    }
    underlyingByToken.set(token, underlying)
    return underlying
  }

  return {
    kind: 'erc4626',
    async resolve({ token, amountIn, executor }) {
      const underlying = await underlyingFor(token)
      if (underlying === null) return null

      // Amount-dependent, so never cached. A contract-level revert here means "interface-compliant
      // but not redeemable this way" (ERC-7540 async vaults, garbage asset() collisions) — treat as
      // not-a-vault and let the raw token route to a venue directly.
      let previewed: bigint
      try {
        previewed = await readContract(client, {
          address: token,
          abi: erc4626Abi,
          functionName: 'previewRedeem',
          args: [amountIn]
        })
      } catch (error) {
        if (!isContractLevelFailure(error)) throw error
        logger.warn('unwrap.preview_reverted', { unwrapper: 'erc4626', token })
        return null
      }
      if (previewed === 0n) {
        logger.warn('unwrap.preview_zero', { unwrapper: 'erc4626', token })
        return null
      }

      return {
        step: {
          tokenIn: token,
          tokenOut: underlying,
          target: token,
          value: 0n,
          callData: encodeFunctionData({
            abi: erc4626Abi,
            functionName: 'redeem',
            args: [amountIn, executor, executor]
          }),
          amountIn: { source: 'balance', offset: ERC4626_SHARES_OFFSET }
        },
        expectedAmountOut: previewed,
        amountOutMinimum: previewed
      }
    }
  }
}
