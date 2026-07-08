import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, Transport } from 'viem'

import { deployless, failover } from '@morpho-org/viem-dlc/transports'
import { createPublicClient, http } from 'viem'
import { getCode } from 'viem/actions'

import type { Config } from './config'

// Gas the deployless lens may burn in its single eth_call. Matches the prime-monorepo reference
// (packages/resolvers/test/measure/clients.ts); the lens itself is read-only so a generous ceiling
// is harmless.
const DEPLOYLESS_GAS_LIMIT = 550_000_000
const RPC_TIMEOUT_MS = 30_000

/**
 * Builds the read-only viem client the lens and simulate paths share: an HTTP transport (a viem-dlc
 * `failover` pair when `RPC_URL_FALLBACK` is set, else a single endpoint) wrapped in viem-dlc's
 * `deployless` transport so {@link readMidnightLiquidationLens} can run the lens deploylessly. Plain
 * reads (`getCode`, `simulateContract`) pass straight through to the base transport. The return is
 * typed against {@link BatchLensTransportType} so the lens fetcher accepts it without a cast.
 */
export function createDeploylessClient(
  config: Pick<Config, 'chain' | 'rpcUrl' | 'rpcUrlFallback'>
): Client<Transport<BatchLensTransportType>> {
  const rpc = (url: string) => http(url, { timeout: RPC_TIMEOUT_MS })
  const base = config.rpcUrlFallback
    ? failover([rpc(config.rpcUrl), rpc(config.rpcUrlFallback)])
    : rpc(config.rpcUrl)
  return createPublicClient({
    chain: config.chain,
    transport: deployless(base, { gasLimit: DEPLOYLESS_GAS_LIMIT })
  })
}

/**
 * Fatal startup liveness gate: throws unless `address` holds non-empty bytecode on this chain. This
 * proves the address is *something* on-chain (catching a typo or a not-yet-deployed address) — it
 * is NOT an identity check: a 7702-delegated EOA or a proxy also returns non-empty code. Confirming
 * it is the expected Executor is the operator's responsibility.
 */
export async function assertContractDeployed(
  client: Client,
  address: Address,
  label: string,
  hint?: string
): Promise<void> {
  const code = await getCode(client, { address })
  // viem's getCode maps '0x' → undefined; the explicit '0x' check is belt-and-suspenders against a
  // non-standard transport that returns the bare empty value.
  if (code === undefined || code === '0x') {
    throw new Error(
      `${label} (${address}) holds no contract code on this chain${hint ? ` — ${hint}` : ''}`
    )
  }
}
