import type { Chain } from 'viem'

import { chainConfig, ethereumFacts } from '@morpho-org/viem-dlc/chains'
import { defineChain } from 'viem'

/**
 * Attaches the `viemDlc` facts viem-dlc needs about a chain: the frame an `eth_call` that leaves
 * `gas` unspecified runs in, what the node does with a `gas` above the cap, and the largest initcode
 * it accepts. Without them `deployless(...)` throws when the client is built.
 *
 * Every chain this repo runs on takes `ethereumFacts`, including Robinhood — which is an Arbitrum
 * Orbit chain, so this is worth stating rather than assuming. prime-monorepo ships
 * `.extend({ viemDlc: ethereumFacts })` for Base, mainnet and Robinhood alike
 * (`packages/web3/src/configs/chains/`), against the same providers, so these are inherited
 * measurements rather than a guess. A chain whose `eth_call` behaves differently — Monad is
 * upstream's worked example — needs its own facts, not this helper.
 */
export function withDlcFacts<const chain extends Chain>(chain: chain) {
  return defineChain({ ...chain, ...chainConfig, viemDlc: ethereumFacts })
}
