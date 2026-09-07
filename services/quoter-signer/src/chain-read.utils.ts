import type { Address, Hex, PublicClient } from 'viem'

import { createPublicClient, erc20Abi, http } from 'viem'

import type { RpcConfig } from './rpc-config.utils'

import { RpcChainMismatchError } from './rpc-chain-mismatch.error'
import { RpcUnavailableError } from './rpc-unavailable.error'

/** Owner/spender pair one ERC-20 allowance read is scoped to. */
export type AllowanceQuery = {
  /** Token contract the allowance lives on. */
  readonly token: Address
  /** Account granting the allowance. */
  readonly owner: Address
  /** Account the allowance is granted to. */
  readonly spender: Address
}

/**
 * Transport boundary for the middleware's independent chain reads. The default is
 * {@link viemChainReadTransport}; tests inject fakes here so the fail-closed validation on top is
 * covered without a provider. Transport failures are thrown raw and typed by the caller into the
 * retryable `RpcUnavailableError` — every operation is read-only, so retrying is always safe.
 */
export type ChainReadTransport = {
  /** Reads the endpoint's EIP-155 chain id. */
  chainId(config: RpcConfig): Promise<number>
  /** Reads the maker's pending transaction count — the next unused nonce. */
  pendingNonce(config: RpcConfig, maker: Address): Promise<number>
  /** Reads the maker's latest (mined) transaction count — the first replaceable nonce. */
  latestNonce(config: RpcConfig, maker: Address): Promise<number>
  /** Reads one ERC-20 allowance. */
  allowance(config: RpcConfig, query: AllowanceQuery): Promise<bigint>
  /** Reads an account's code; empty (`0x`) for a plain EOA. */
  code(config: RpcConfig, account: Address): Promise<Hex>
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
 * lifetime of the Lambda execution environment. Every call is a plain read-only JSON-RPC request;
 * every validation decision stays in the `readMaker*` functions of this module.
 */
export const viemChainReadTransport: ChainReadTransport = {
  async chainId(config) {
    return rpcClient(config.url).getChainId()
  },
  async pendingNonce(config, maker) {
    return rpcClient(config.url).getTransactionCount({ address: maker, blockTag: 'pending' })
  },
  async latestNonce(config, maker) {
    return rpcClient(config.url).getTransactionCount({ address: maker, blockTag: 'latest' })
  },
  async allowance(config, query) {
    // Pending-state read: the nonce read counts in-flight transactions, so the allowance must
    // see them too or a still-pending approval would pass the no-op check and be signed again.
    return rpcClient(config.url).readContract({
      address: query.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [query.owner, query.spender],
      blockTag: 'pending'
    })
  },
  async code(config, account) {
    const code = await rpcClient(config.url).getCode({ address: account, blockTag: 'pending' })
    return code ?? '0x'
  }
}

const verifyChainId = async (
  config: RpcConfig,
  expectedChainId: number,
  transport: ChainReadTransport
): Promise<void> => {
  let chainId: number
  try {
    chainId = await transport.chainId(config)
  } catch (error) {
    throw new RpcUnavailableError('chain-id', { cause: error })
  }
  if (chainId !== expectedChainId) throw new RpcChainMismatchError()
}

const validNonce = (nonce: number): boolean => Number.isSafeInteger(nonce) && nonce >= 0

/**
 * Reads the maker's current pending nonce through the middleware's own endpoint — the
 * TIB-2026-08-12 independent nonce read every transaction-signing intent requires. The endpoint's
 * chain id is verified against the policy pin on every call before the nonce is trusted, so a
 * repointed or misconfigured provider cannot feed another chain's account state into a signature
 * that commits to the pinned chain.
 * @param config - Validated RPC endpoint addressing.
 * @param expected - Policy-pinned chain id and maker address the reads are scoped to.
 * @returns The maker's pending transaction count — the nonce the middleware signs.
 * @throws `RpcUnavailableError` (retryable) when either read fails or returns a malformed value;
 * `RpcChainMismatchError` (terminal) when the endpoint serves a different chain.
 */
export const readMakerPendingNonce = async (
  config: RpcConfig,
  expected: { readonly chainId: number; readonly maker: Address },
  transport: ChainReadTransport = viemChainReadTransport
): Promise<number> => {
  await verifyChainId(config, expected.chainId, transport)
  let nonce: number
  try {
    nonce = await transport.pendingNonce(config, expected.maker)
  } catch (error) {
    throw new RpcUnavailableError('pending-nonce', { cause: error })
  }
  // A nonce outside safe-integer range (or negative) is a malformed provider response; treating
  // it as unavailable keeps the denial retryable without ever signing a fabricated nonce.
  if (!validNonce(nonce)) throw new RpcUnavailableError('pending-nonce')
  return nonce
}

/**
 * The maker's replaceable nonce window, read in one pass: `latest` is the first nonce not yet
 * mined (the lowest an explicit-nonce signature could still land at) and `pending` the first not
 * yet occupied by an in-flight transaction. Explicit placements are signed only inside
 * `[latest, pending]` — and a self-cancel only inside `[latest, pending)`: it replaces an
 * in-flight transaction, so its slot must be occupied, while a revocation may also take the next
 * unused slot for final cleanup without stockpiling a future-nonce artifact.
 */
export type MakerNonceWindow = {
  /** Latest (mined) transaction count — the first nonce a signature could replace. */
  readonly latest: number
  /** Pending transaction count — the next unused nonce, the window's upper bound. */
  readonly pending: number
}

/**
 * Reads the maker's {@link MakerNonceWindow} through the middleware's own endpoint, with the same
 * chain-id verification and fail-closed value validation as {@link readMakerPendingNonce}. The
 * pending count is read **before** the latest count: the latest count is monotonic, so reading
 * it second makes the window's lower bound as fresh as possible — a nonce that mined between the
 * reads is rejected instead of signed as an artifact that can no longer be included (the other
 * order admits exactly that). The upper bound is weaker by nature: the pending count is a
 * snapshot of the node's mempool, which can evict, so an accepted nonce can sit transiently
 * above the live next-unused count — bounded by the maker's own previously signed in-flight
 * artifacts (the same drift the routine pending-nonce read carries) and resolved for good by the
 * recorded-transaction inventory of the ledger increment. A pending count below the later-read
 * latest count means transactions mined between the reads, or the provider mixed lagging nodes;
 * either way the window moved and is refused as retryable.
 * @param config - Validated RPC endpoint addressing.
 * @param expected - Policy-pinned chain id and maker address the reads are scoped to.
 * @returns The maker's current nonce window.
 * @throws `RpcUnavailableError` (retryable) when any read fails or the window is incoherent;
 * `RpcChainMismatchError` (terminal) when the endpoint serves a different chain.
 */
export const readMakerNonceWindow = async (
  config: RpcConfig,
  expected: { readonly chainId: number; readonly maker: Address },
  transport: ChainReadTransport = viemChainReadTransport
): Promise<MakerNonceWindow> => {
  await verifyChainId(config, expected.chainId, transport)
  let pending: number
  try {
    pending = await transport.pendingNonce(config, expected.maker)
  } catch (error) {
    throw new RpcUnavailableError('pending-nonce', { cause: error })
  }
  if (!validNonce(pending)) throw new RpcUnavailableError('pending-nonce')
  let latest: number
  try {
    latest = await transport.latestNonce(config, expected.maker)
  } catch (error) {
    throw new RpcUnavailableError('latest-nonce', { cause: error })
  }
  if (!validNonce(latest) || pending < latest) throw new RpcUnavailableError('latest-nonce')
  return { latest, pending }
}

/**
 * Reads one ERC-20 allowance of the maker through the middleware's own endpoint — the independent
 * allowance-state read the setup-remediation surface bases its no-op denial on — with the same
 * chain-id verification as every other read. The production transport reads pending state, the
 * same speculative view as the nonce read, so an approval still in flight already counts and a
 * duplicate is denied instead of signed at the next nonce.
 * @param config - Validated RPC endpoint addressing.
 * @param expected - Policy-pinned chain id plus the manifest-pinned token/owner/spender triple.
 * @returns The current allowance.
 * @throws `RpcUnavailableError` (retryable) when either read fails or returns a malformed value;
 * `RpcChainMismatchError` (terminal) when the endpoint serves a different chain.
 */
export const readMakerAllowance = async (
  config: RpcConfig,
  expected: { readonly chainId: number } & AllowanceQuery,
  transport: ChainReadTransport = viemChainReadTransport
): Promise<bigint> => {
  await verifyChainId(config, expected.chainId, transport)
  let allowance: bigint
  try {
    allowance = await transport.allowance(config, {
      token: expected.token,
      owner: expected.owner,
      spender: expected.spender
    })
  } catch (error) {
    throw new RpcUnavailableError('allowance', { cause: error })
  }
  // ERC-20 allowances are uint256; anything else is a malformed provider or transport response.
  if (typeof allowance !== 'bigint' || allowance < 0n) throw new RpcUnavailableError('allowance')
  return allowance
}

/**
 * Reads the maker's account code through the middleware's own endpoint, with the same chain-id
 * verification as every other read. The self-cancel path requires it to be empty before signing:
 * an EIP-7702 delegation designator on the maker would make the "empty self-send" execute the
 * delegated code in the maker's context instead of being an economic no-op, so a maker that is
 * not provably codeless denies rather than signs. Like every pre-sign read this is a snapshot —
 * a delegation landing after signing is out of scope until the ledger increment's recorded
 * inventory.
 * @param config - Validated RPC endpoint addressing.
 * @param expected - Policy-pinned chain id and maker address the read is scoped to.
 * @returns The maker's code; `0x` for a plain EOA.
 * @throws `RpcUnavailableError` (retryable) when either read fails or returns a malformed value;
 * `RpcChainMismatchError` (terminal) when the endpoint serves a different chain.
 */
export const readMakerCode = async (
  config: RpcConfig,
  expected: { readonly chainId: number; readonly maker: Address },
  transport: ChainReadTransport = viemChainReadTransport
): Promise<Hex> => {
  await verifyChainId(config, expected.chainId, transport)
  let code: Hex
  try {
    code = await transport.code(config, expected.maker)
  } catch (error) {
    throw new RpcUnavailableError('maker-code', { cause: error })
  }
  if (typeof code !== 'string' || !code.startsWith('0x')) {
    throw new RpcUnavailableError('maker-code')
  }
  return code
}
