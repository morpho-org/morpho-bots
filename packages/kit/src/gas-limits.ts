/** RPC endpoint kinds we track `eth_call` gas-cap floors for. */
export type EndpointKind = 'alchemy' | 'erpc'

/**
 * Per-(chainId, endpointKind) `eth_call` gas-limit floor — the largest `gas` the endpoint accepts
 * when the request is replicated enough times to hit every upstream an aggregator might delegate to.
 *
 * PORTED from prime-monorepo (`packages/web3/src/configs/chains/gas-limits.ts`), which measured these
 * with a saturation probe against each endpoint. Refresh from viem-dlc's `gas_limit_observed` on the
 * wide event rather than re-guessing.
 */
const RPC_GAS_LIMITS: Record<number, Partial<Record<EndpointKind, number>>> = {
  1: { alchemy: 550_000_000, erpc: 550_000_000 },
  8453: { alchemy: 550_000_000, erpc: 550_000_000 },
  4663: { alchemy: 550_000_000, erpc: 550_000_000 }
}

function endpointKindOf(rpcUrl: string): EndpointKind | undefined {
  const url = rpcUrl.toLowerCase()
  if (url.includes('alchemy.com')) return 'alchemy'
  if (url.includes('rpc.morpho.dev')) return 'erpc'
  return undefined
}

/**
 * The `eth_call` gas cap to state for this endpoint, or `undefined` for one we have not measured.
 *
 * This is a claim about the provider, not a ceiling we choose, so an unmeasured endpoint states
 * nothing rather than a guess: viem-dlc then sizes the opening wave from the pages it gets back,
 * which costs a round trip. A wrong figure is worse — on a chain that sends it as each chunk's `gas`
 * it fails the request outright.
 */
export function ethCallGasCap(chainId: number, rpcUrl: string): number | undefined {
  const kind = endpointKindOf(rpcUrl)
  return kind ? RPC_GAS_LIMITS[chainId]?.[kind] : undefined
}
