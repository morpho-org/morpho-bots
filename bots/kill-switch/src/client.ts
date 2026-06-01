import type { Chain } from 'viem'

import { createPublicClient, http } from 'viem'
import { base, mainnet } from 'viem/chains'

import type { KillSwitchBotConfig } from './schema'

// Supported chains, declared explicitly (CONVENTIONS: each bot declares its chains). viem's
// extractChain returns undefined for an unknown id; we fail loud instead. Extend as chains are added.
const CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base
}

export function resolveChain(id: number): Chain {
  const chain = CHAINS_BY_ID[id]
  if (!chain) throw new Error(`Unsupported chain id: ${id}`)
  return chain
}

// Phase 1 reads a single HTTP endpoint; Phase 2 swaps the transport to viem's `fallback` over the
// full list. Isolating client construction here keeps that change to one line.
export function createBotClient(chain: KillSwitchBotConfig['chain']) {
  const [primary] = chain.rpc.http
  if (!primary) throw new Error('chain.rpc.http must contain at least one endpoint')
  return createPublicClient({ chain: resolveChain(chain.id), transport: http(primary) })
}
