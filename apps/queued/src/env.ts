import type { Address } from 'viem'

import { getAddress, isAddress, parseGwei } from 'viem'

// Queue-daemon env resolvers: signer-agent selection and fee ceiling.

/** The env table the queue's resolvers read — env-var names to (optional) values. */
type Env = Record<string, string | undefined>

const DEFAULT_MAX_FEE_GWEI = '300'

// The optional operator EOA, checksum-normalized when set. Unlike act's required skim recipient, this
// returns `undefined` when unset — the single validation site for `LIQUIDATOR_ADDRESS` on the signing
// paths (the key cross-check and the agent-handshake check).
export function resolveLiquidatorAddress(env: Env): Address {
  const raw = env.LIQUIDATOR_ADDRESS?.trim()
  if (!raw) throw new Error('Missing required env var: LIQUIDATOR_ADDRESS')
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`LIQUIDATOR_ADDRESS is not a valid address: ${raw}`)
  }
  return getAddress(raw)
}

/** The mandatory out-of-process signer. The queue never receives or reads private key material. */
export type SignerBackend = {
  kind: 'agent'
  socketPath: string
}

/**
 * Resolves the mandatory signing-agent socket and optional expected address. Local private-key
 * fallback is deliberately unsupported: armed queue operation must cross the signer trust boundary.
 */
export function resolveSignerBackend(env: Env): SignerBackend {
  const socketPath = env.SIGNER_SOCKET?.trim()
  if (!socketPath) {
    throw new Error('Missing required env var: SIGNER_SOCKET (armed queues require morpho-signer)')
  }
  if (env.LIQUIDATOR_PRIVATE_KEY?.trim()) {
    throw new Error(
      'LIQUIDATOR_PRIVATE_KEY is not accepted by morpho-queued; configure SIGNER_PRIVATE_KEY only on morpho-signer'
    )
  }
  return { kind: 'agent', socketPath }
}

export function resolveMaxFeeWei(env: Env): bigint {
  const maxFeeGwei = env.MAX_FEE_GWEI?.trim() || DEFAULT_MAX_FEE_GWEI
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new Error(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }
  return parseGwei(maxFeeGwei)
}
