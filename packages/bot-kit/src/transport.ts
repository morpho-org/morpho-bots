import { failover } from '@morpho-org/viem-dlc/transports'
import { http } from 'viem'

/** Per-request timeout for every bot-kit HTTP transport (the read client and the signer). */
const RPC_TIMEOUT_MS = 30_000

/**
 * The base HTTP transport bot-kit clients share: a viem-dlc `failover` pair when `fallbackUrl` is
 * set, else a single `http` endpoint — each with a {@link RPC_TIMEOUT_MS} per-request timeout.
 * Callers layer their own concerns on top: the read client wraps it in viem-dlc's `deployless`, the
 * signer casts it to viem's `Transport` (see the call sites for why each is needed).
 *
 * `options.batch` coalesces concurrent JSON-RPC calls into one batched HTTP request (viem
 * `batch: { wait: 0 }`), on the primary and the fallback alike. Opt in for a tick that fans out many
 * small reads — an SDK fetcher issuing dozens of `eth_call`s per vault; it buys nothing for a bot
 * whose reads already go through a batch lens. Caveat: a batch shares one HTTP request, so a
 * transport-level failure fails every call in it together.
 */
export function createHttpTransport(
  primaryUrl: string,
  fallbackUrl?: string,
  options?: { batch?: boolean }
) {
  const rpc = (url: string) =>
    http(url, {
      timeout: RPC_TIMEOUT_MS,
      ...(options?.batch ? { batch: { wait: 0 } } : {})
    })
  return fallbackUrl ? failover([rpc(primaryUrl), rpc(fallbackUrl)]) : rpc(primaryUrl)
}
