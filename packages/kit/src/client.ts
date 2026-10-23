import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Chain, Client, Transport } from 'viem'

import { createPublicClient } from 'viem'
import { getCode } from 'viem/actions'

import { withDlcFacts } from './chain-facts'
import { createDeploylessTransport } from './transport'

/**
 * Caps the bytes of one chunk's `eth_call` data, below whatever the provider itself accepts. Only
 * set it when an endpoint rejects large requests; the chain's initcode limit and the frame's gas
 * already bound a chunk.
 *
 * Fails loud on anything it cannot read exactly, matching the bots' own `intEnv`: `parseInt` would
 * take `100kb` as 100 and quietly chunk every lens read to 100 bytes, and a value past 2^53 would
 * lose precision rather than being rejected.
 */
function maxBatchSize(env: Record<string, string | undefined>): number | undefined {
  const raw = env.MAX_DEPLOYLESS_BATCH_SIZE?.trim()
  if (!raw) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new Error(`MAX_DEPLOYLESS_BATCH_SIZE must be a positive integer, got: ${raw}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`MAX_DEPLOYLESS_BATCH_SIZE must be a positive safe integer, got: ${raw}`)
  }
  return value
}

/**
 * Builds the read-only viem client a bot's lens and simulate paths share: one `deployless` transport
 * per endpoint, behind a viem-dlc `failover` when `rpcUrlFallback` is set, so each provider states
 * its own `eth_call` gas cap. Plain reads (`getCode`, `eth_call`) carry no `policy` sentinel and pass
 * straight through. The return is typed against {@link BatchLensTransportType} so
 * `readDeploylessBatchLens`-based fetchers accept it without a cast.
 *
 * The chain's viem-dlc facts are attached HERE rather than at each bot's config, so a chain that
 * reaches this function can never be missing them — `deployless` would otherwise throw while the
 * client is being built, at whichever call site forgot.
 */
export function createDeploylessClient(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  env?: Record<string, string | undefined>
}): Client<Transport<BatchLensTransportType>> {
  const chain = withDlcFacts(options.chain)
  return createPublicClient({
    chain,
    transport: createDeploylessTransport({
      chainId: chain.id,
      rpcUrl: options.rpcUrl,
      rpcUrlFallback: options.rpcUrlFallback,
      batchSize: maxBatchSize(options.env ?? process.env)
    })
  })
}

/**
 * Fatal startup liveness gate: throws unless `address` holds non-empty bytecode on this chain. This
 * proves the address is *something* onchain (catching a typo or a not-yet-deployed address) — it
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
