import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isAddressEqual, isHex, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// The queue's shared env resolvers — the signer-backend selection, the fee ceiling, and the
// per-position backoff bounds. Both liquidation cores read these identically, so they live here (one
// place to validate `SIGNER_SOCKET`/`LIQUIDATOR_PRIVATE_KEY`/`LIQUIDATOR_ADDRESS`/`MAX_FEE_GWEI`/
// `BACKOFF_*`) rather than byte-duplicated in each core's config.ts.

/** The env table the queue's resolvers read — env-var names to (optional) values. */
type Env = Record<string, string | undefined>

const DEFAULT_MAX_FEE_GWEI = '300'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes
const DEFAULT_BACKOFF_BASE_BLOCKS = 2n
const DEFAULT_BACKOFF_MAX_BLOCKS = 64n

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

// Parses an optional non-negative integer env var into a bigint, with a default.
function bigintEnv(env: Env, name: string, def: bigint): bigint {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  return BigInt(raw)
}

export function resolvePrivateKey(env: Env): Hex {
  const liquidatorPrivateKey = required(env, 'LIQUIDATOR_PRIVATE_KEY')
  if (
    !isHex(liquidatorPrivateKey, { strict: true }) ||
    liquidatorPrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
  ) {
    throw new Error('LIQUIDATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return liquidatorPrivateKey
}

// The optional operator EOA, checksum-normalized when set. Unlike act's required skim recipient, this
// returns `undefined` when unset — the single validation site for `LIQUIDATOR_ADDRESS` on the signing
// paths (the key cross-check and the agent-handshake check).
export function optionalLiquidatorAddress(env: Env): Address | undefined {
  const raw = env.LIQUIDATOR_ADDRESS?.trim()
  if (!raw) return undefined
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`LIQUIDATOR_ADDRESS is not a valid address: ${raw}`)
  }
  return getAddress(raw)
}

// Full-config (tickOnce/queue path) cross-check: when the operator sets LIQUIDATOR_ADDRESS alongside
// the private key, the two must agree — a mismatch means act would skim seized funds to a wallet the
// queue doesn't sign for. When absent, the key remains the single source of truth (no new
// requirement on the tick path).
export function assertLiquidatorAddressMatchesKey(env: Env, privateKey: Hex): void {
  const address = optionalLiquidatorAddress(env)
  if (!address) return
  const derived = privateKeyToAccount(privateKey).address
  if (!isAddressEqual(address, derived)) {
    throw new Error(
      `LIQUIDATOR_ADDRESS (${address}) does not match the address derived from LIQUIDATOR_PRIVATE_KEY (${derived}) — act and queue would target different wallets`
    )
  }
}

/**
 * How the `queue` obtains a signer: the in-process local key (dev default), or the out-of-process
 * signing agent (`SIGNER_SOCKET`), which is the sole key holder. In agent mode the private key is
 * NEVER read here; the operator EOA (`LIQUIDATOR_ADDRESS`, when set) is carried so the queue can
 * cross-check it against the agent's handshake address.
 */
export type SignerBackend =
  | { kind: 'local'; privateKey: Hex }
  | { kind: 'agent'; socketPath: string; expectedAddress: Address | undefined }

/**
 * Selects the signer backend. `SIGNER_SOCKET` set → the agent backend (the key is NOT read; the
 * agent holds it), carrying `LIQUIDATOR_ADDRESS` for the queue's handshake cross-check. Unset → the
 * local backend: `resolvePrivateKey` + the `LIQUIDATOR_ADDRESS` key cross-check, exactly as before.
 */
export function resolveSignerBackend(env: Env): SignerBackend {
  const socketPath = env.SIGNER_SOCKET?.trim()
  if (socketPath) {
    return { kind: 'agent', socketPath, expectedAddress: optionalLiquidatorAddress(env) }
  }
  const privateKey = resolvePrivateKey(env)
  assertLiquidatorAddressMatchesKey(env, privateKey)
  return { kind: 'local', privateKey }
}

export function resolveMaxFeeWei(env: Env): bigint {
  const maxFeeGwei = env.MAX_FEE_GWEI?.trim() || DEFAULT_MAX_FEE_GWEI
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new Error(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }
  return parseGwei(maxFeeGwei)
}

// Per-position failure-backoff bounds. Shared by `act` (which filters via `shouldSkip`) and the
// `queue` command (the sole writer, which `record`s/`clear`s), so both read them from ONE resolver —
// the queue's `record()` computes the cooldown `until`, and act only compares against it.
export function resolveBackoff(env: Env): { baseBlocks: bigint; maxBlocks: bigint } {
  return {
    baseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', DEFAULT_BACKOFF_BASE_BLOCKS),
    maxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', DEFAULT_BACKOFF_MAX_BLOCKS)
  }
}
