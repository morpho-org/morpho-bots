import type { Address, Hex } from 'viem'

/**
 * The JSON-Lines pipe wire contract: the record shapes `sense`/`act`/`queue` exchange on stdout,
 * one record per line. stdout is the data plane; logs go to stderr (see {@link ./logger}).
 *
 * Conventions baked into these types:
 * - **Bigints ride as bare decimal strings** (`value`), and hex values stay `0x`-strings. This is
 *   NOT the `{ __bigint__ }` tagging `@repo/utils` uses for state files: actors re-derive numeric
 *   payloads from the ID rather than parse them off the wire, so a lossless round-trip is
 *   unnecessary and the bare string stays jq- and human-friendly.
 * - **`op` and `status` are open `string`s.** Domain vocabularies (`'liq'`, `'quote_failed'`, …)
 *   are core-owned; bot-kit stays free of bot shapes and each core narrows these fields itself.
 * - **Additive fields never bump `v`.** {@link WIRE_VERSION} increments only on a breaking envelope
 *   change; a reader seeing a higher `v` treats it as unknown.
 */

/** Current wire-envelope version. A reader that sees an unknown `v` rejects the record. */
export const WIRE_VERSION = 1

/**
 * Fields common to every wire record. `op` is an open string (domain-owned vocabulary); `at` is an
 * ISO-8601 timestamp; `summary` is the one human-readable line behind `jq -r .summary`. The
 * `domain`/`op`/`chainId` fields — not the opaque `id` — are authoritative for routing.
 */
export type WireEnvelope = {
  v: number
  kind: 'opportunity' | 'tx' | 'outcome'
  id: string
  domain: string
  op: string
  chainId: number
  at: string
  summary: string
}

/**
 * An actionable on-chain opportunity emitted by `sense`. `data` is a domain-owned payload that is
 * advisory/diagnostic only — `act` never consumes it and always re-derives from the ID.
 */
export type OpportunityRecord = WireEnvelope & {
  kind: 'opportunity'
  data?: Record<string, unknown>
}

/**
 * A freshly simulated transaction emitted by `act`. `value` is a bare decimal string (wei);
 * `simulated` is advisory (act's early filter plus observability) — the authoritative sign-what-you-
 * simulate gate lives in `queue`.
 */
export type TxRecord = WireEnvelope & {
  kind: 'tx'
  to: Address
  data: Hex
  value?: string
  simulated: { status: 'ok'; block: number }
}

/**
 * A stage result emitted by `act` and `queue`. `status` is an open string (core-owned vocabulary);
 * transient infrastructure failures are stderr logs plus exit 1, never outcomes.
 */
export type OutcomeRecord = WireEnvelope & {
  kind: 'outcome'
  status: string
  reason?: string
  block?: number
  txHash?: Hex
  nonce?: number
}

/** Any record that can appear on the wire. */
export type WireRecord = OpportunityRecord | TxRecord | OutcomeRecord
