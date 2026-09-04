import type { Address, PublicClient } from 'viem'

import { createPublicClient, http } from 'viem'

import type { RpcConfig } from './rpc-config.utils'

import { RpcChainMismatchError } from './rpc-chain-mismatch.error'
import { RpcUnavailableError } from './rpc-unavailable.error'

/**
 * Transport boundary for the middleware's independent chain reads. The default is
 * {@link viemChainReadTransport}; tests inject fakes here so the fail-closed validation on top is
 * covered without a provider. Transport failures are thrown raw and typed by the caller into the
 * retryable `RpcUnavailableError` — both operations are read-only, so retrying is always safe.
 */
export type ChainReadTransport = {
  /** Reads the endpoint's EIP-155 chain id. */
  chainId(config: RpcConfig): Promise<number>
  /** Reads the maker's pending transaction count — the next unused nonce. */
  pendingNonce(config: RpcConfig, maker: Address): Promise<number>
}

const rpcClients = new Map<string, PublicClient>()

const rpcClient = (url: string): PublicClient => {
  const cached = rpcClients.get(url)
  if (cached !== undefined) return cached
  const client = createPublicClient({ transport: http(url) })
  rpcClients.set(url, client)
  return client
}

/**
 * Production transport backed by a viem public client, reusing one client per endpoint for the
 * lifetime of the Lambda execution environment. Both calls are plain read-only JSON-RPC requests;
 * every validation decision stays in {@link readMakerPendingNonce}.
 */
export const viemChainReadTransport: ChainReadTransport = {
  async chainId(config) {
    return rpcClient(config.url).getChainId()
  },
  async pendingNonce(config, maker) {
    return rpcClient(config.url).getTransactionCount({ address: maker, blockTag: 'pending' })
  }
}

/**
 * Reads the maker's current pending nonce through the middleware's own endpoint — the
 * TIB-2026-08-12 independent nonce read every transaction-signing intent requires. The endpoint's
 * chain id is verified against the policy pin on every call before the nonce is trusted, so a
 * repointed or misconfigured provider cannot feed another chain's account state into a signature
 * that commits to the pinned chain.
 * @param config - Validated RPC endpoint addressing.
 * @param expected - Policy-pinned chain id and maker address the reads are scoped to.
 * @param transport - Chain-read transport; defaults to {@link viemChainReadTransport},
 * injectable for tests.
 * @returns The maker's pending transaction count — the nonce the middleware signs.
 * @throws `RpcUnavailableError` (retryable) when either read fails or returns a malformed value;
 * `RpcChainMismatchError` (terminal) when the endpoint serves a different chain.
 */
export const readMakerPendingNonce = async (
  config: RpcConfig,
  expected: { readonly chainId: number; readonly maker: Address },
  transport: ChainReadTransport = viemChainReadTransport
): Promise<number> => {
  let chainId: number
  try {
    chainId = await transport.chainId(config)
  } catch (error) {
    throw new RpcUnavailableError('chain-id', { cause: error })
  }
  if (chainId !== expected.chainId) throw new RpcChainMismatchError()
  let nonce: number
  try {
    nonce = await transport.pendingNonce(config, expected.maker)
  } catch (error) {
    throw new RpcUnavailableError('pending-nonce', { cause: error })
  }
  // A nonce outside safe-integer range (or negative) is a malformed provider response; treating
  // it as unavailable keeps the denial retryable without ever signing a fabricated nonce.
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new RpcUnavailableError('pending-nonce')
  return nonce
}
