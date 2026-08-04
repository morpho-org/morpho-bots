import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

import type { ChainReader } from './viem-setup-state.service'

/**
 * Creates the narrow viem-backed chain reader consumed by setup-state checks.
 * @param rpcUrl - HTTP JSON-RPC endpoint of the Base provider.
 * @param timeout - Per-request timeout in milliseconds.
 * @returns A `ChainReader` bound to one public client.
 * @remarks Read-only; performs no writes. Missing block numbers read the latest block.
 */
export const createChainReader = (rpcUrl: string, timeout: number): ChainReader => {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout }) })
  return {
    getChainId: () => client.getChainId(),
    getCode: parameters => client.getCode(parameters),
    getBalance: parameters => client.getBalance(parameters),
    getBlock: parameters =>
      parameters.blockNumber === undefined
        ? client.getBlock({ blockTag: 'latest' })
        : client.getBlock({ blockNumber: parameters.blockNumber }),
    readContract: parameters => client.readContract(parameters as never)
  }
}
