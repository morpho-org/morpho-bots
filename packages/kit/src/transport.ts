import type { EIP1193RequestFn, PublicRpcSchema, Transport } from 'viem'

import { deployless, failover } from '@morpho-org/viem-dlc/transports'
import { http } from 'viem'

import { ethCallGasCap } from './gas-limits'

/** Per-request timeout for every kit HTTP transport (the read client and the signer). */
const RPC_TIMEOUT_MS = 30_000

/**
 * The base HTTP transport kit clients share: a viem-dlc `failover` pair when `fallbackUrl` is
 * set, else a single `http` endpoint — each with a {@link RPC_TIMEOUT_MS} per-request timeout.
 */
export function createHttpTransport(primaryUrl: string, fallbackUrl?: string) {
  const rpc = (url: string) => http(url, { timeout: RPC_TIMEOUT_MS })
  return fallbackUrl ? failover([rpc(primaryUrl), rpc(fallbackUrl)]) : rpc(primaryUrl)
}

/**
 * The read transport: `deployless` **inside** each failover branch, not wrapped around the pair.
 *
 * `deployless`'s `gasLimit` states the provider's own `eth_call` cap, and a failover pair may point
 * at two providers whose caps differ — so each branch states its own, looked up from its URL. The
 * previous shape (`deployless(failover([...]))`) could only state one for both.
 *
 * `failover` types itself `viem-dlc-failover`, so the composed transport is re-labelled: every
 * branch underneath is a `deployless` and the RPC schema is identical, and callers are typed against
 * `Transport<'viem-dlc-deployless'>`.
 */
export function createDeploylessTransport(options: {
  chainId: number
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  batchSize?: number | undefined
}): Transport<'viem-dlc-deployless'> {
  const { chainId, rpcUrl, rpcUrlFallback, batchSize } = options
  const branch = (url: string) =>
    deployless(http(url, { timeout: RPC_TIMEOUT_MS }), {
      gasLimit: ethCallGasCap(chainId, url),
      batchSize
    })

  if (!rpcUrlFallback) return branch(rpcUrl)
  return asDeploylessTransport(failover([branch(rpcUrl), branch(rpcUrlFallback)]))
}

/**
 * Re-labels a transport as `viem-dlc-deployless`. PORTED from prime-monorepo
 * (`packages/web3/src/configs/rpcs.ts`), which composes the same failover-of-deployless shape.
 * Drops the deployless `value` typing (`{ gasLimit }`) — no consumer reads it through the client,
 * and with one cap per branch there is no single value to report anyway.
 */
function asDeploylessTransport(
  transport: Transport<string, unknown, EIP1193RequestFn<PublicRpcSchema>>
): Transport<'viem-dlc-deployless'> {
  return ((params: Parameters<typeof transport>[0]) => {
    const config = transport(params)
    return {
      ...config,
      config: {
        ...config.config,
        key: 'viem-dlc-deployless',
        name: '[viem-dlc] deployless',
        type: 'viem-dlc-deployless'
      }
    }
  }) as Transport<'viem-dlc-deployless'>
}
