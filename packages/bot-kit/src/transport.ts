import { failover } from '@morpho-org/viem-dlc/transports'
import { http } from 'viem'

/** Per-request timeout for every bot-kit HTTP transport (the read client and the signer). */
const RPC_TIMEOUT_MS = 30_000

/**
 * The base HTTP transport bot-kit clients share: a viem-dlc `failover` pair when `fallbackUrl` is
 * set, else a single `http` endpoint — each with a {@link RPC_TIMEOUT_MS} per-request timeout.
 * Callers layer their own concerns on top: the read client wraps it in viem-dlc's `deployless`, the
 * signer casts it to viem's `Transport` (see the call sites for why each is needed).
 */
export function createHttpTransport(primaryUrl: string, fallbackUrl?: string) {
  const rpc = (url: string) => http(url, { timeout: RPC_TIMEOUT_MS })
  return fallbackUrl ? failover([rpc(primaryUrl), rpc(fallbackUrl)]) : rpc(primaryUrl)
}
