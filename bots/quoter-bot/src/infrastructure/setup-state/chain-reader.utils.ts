import { createPublicClient, http } from 'viem'

import type { SupportedChainId } from '../../config/supported-chains.utils'
import type { ChainReader } from './viem-setup-state.service'

import { supportedChain } from '../../config/supported-chains.utils'

/**
 * Creates the narrow viem-backed chain reader consumed by setup-state checks.
 * @param rpcUrl - HTTP JSON-RPC endpoint of the configured chain's provider.
 * @param timeout - Per-request timeout in milliseconds.
 * @param chainId - Configured chain whose viem definition backs the client.
 * @returns A `ChainReader` bound to one public client.
 * @remarks Read-only; performs no writes. Missing block numbers read the latest block. The chain
 * is only a client-side definition: setup checks still assert the connected chain matches.
 */
export const createChainReader = (
  rpcUrl: string,
  timeout: number,
  chainId: SupportedChainId
): ChainReader => {
  const client = createPublicClient({
    chain: supportedChain(chainId),
    transport: http(rpcUrl, { timeout })
  })
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
