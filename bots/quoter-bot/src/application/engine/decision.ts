import type { Data } from '@repo/engine'

/**
 * What a market's decision asks the kernel for: `cancel` withdraws `payload.cancel`, `replace`
 * cancels it and publishes the prepared tree. `identity` is what the decision wants live.
 */
export type Act = Readonly<{
  kind: 'cancel' | 'replace'
  identity: string
  payload: Data
  /** Operator-readable reason, logged at admission: "recenter: 530 vs 500 > 20". */
  condition: string
}>

/**
 * One market's decision from one world reading. `keep` names the commitments it still affirms;
 * `desire` names the publication it wants live, which its act's evidence rests on.
 */
export type Decision = Readonly<{
  keep: readonly string[]
  desire?: string
  act?: Act
  steady: boolean
  /** Halts the whole bot, which withdraws every commitment: for a failure no market can contain. */
  halt?: string
  detail?: Data
}>

/** One commitment the kernel holds for a market, as its decision reads it: `detail` is its group. */
export type LiveCommitment = Readonly<{ id: string; detail: Data }>

/** The commitments a market may count as its own live book: never one adopted from an earlier run. */
export type LiveView = Readonly<{ live: readonly LiveCommitment[] }>

/** A preparation as the decision that asked for it sees it. */
export type Prepared<T> =
  | Readonly<{ status: 'unrequested' }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'ready'; value: T }>
  | Readonly<{ status: 'failed'; failure: Readonly<{ code: string }> }>
  | Readonly<{ status: 'timeout' }>

/** A source reading as a decision sees it: not read yet, or read, or failed with a code. */
export type Observed<T> =
  | Readonly<{ status: 'ready'; value: T }>
  | Readonly<{ status: 'failed'; failure: Readonly<{ code: string }> }>
  | Readonly<{ status: 'unobserved' }>

/** How an act the kernel admitted ended, with every transaction it included, in step order. */
export type Outcome = Readonly<{
  intentId: string
  kind: Act['kind']
  notice: 'settled' | 'refused' | 'abandoned' | 'compensated' | 'failed'
  reason?: string
  payload: Data
  transactions: readonly Readonly<{ step: number; hash: string; block: number }>[]
}>

/** A monitor's verdict; any `halt` halts the bot. */
export type Verdict = Readonly<{ ok: true }> | Readonly<{ ok: false; halt: string }>
