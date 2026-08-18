import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Chain, Client, Transport } from 'viem'

import { deployless } from '@morpho-org/viem-dlc/transports'
import { createPublicClient } from 'viem'
import { getCode } from 'viem/actions'

import { createHttpTransport } from './transport'

// Gas the deployless lens may burn in its single eth_call. Matches the prime-monorepo reference
// (packages/resolvers/test/measure/clients.ts); the lens itself is read-only so a generous ceiling
// is harmless.
const DEPLOYLESS_GAS_LIMIT = 550_000_000

/**
 * Builds the read-only viem client a bot's lens and simulate paths share: an HTTP transport (a
 * viem-dlc `failover` pair when `rpcUrlFallback` is set, else a single endpoint) wrapped in
 * viem-dlc's `deployless` transport so the bot's batch lens can run deploylessly. Plain reads
 * (`getCode`, `eth_call`) pass straight through to the base transport. The return is typed against
 * {@link BatchLensTransportType} so `readDeploylessBatchLens`-based fetchers accept it without a cast.
 *
 * `batch` is off by default and applies to the underlying HTTP endpoint(s), not the `deployless`
 * wrapper — see {@link createHttpTransport} for when it pays off and what it couples.
 */
export function createDeploylessClient(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  batch?: boolean | undefined
}): Client<Transport<BatchLensTransportType>> {
  const base = createHttpTransport(options.rpcUrl, options.rpcUrlFallback, {
    batch: options.batch
  })
  return createPublicClient({
    chain: options.chain,
    transport: deployless(base, { gasLimit: DEPLOYLESS_GAS_LIMIT })
  })
}

/**
 * Fatal startup liveness gate: throws unless `address` holds non-empty bytecode on this chain. This
 * proves the address is *something* on-chain (catching a typo or a not-yet-deployed address) — it
 * is NOT an identity check: a 7702-delegated EOA or a proxy also returns non-empty code. Confirming
 * it is the expected contract is the operator's responsibility.
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
