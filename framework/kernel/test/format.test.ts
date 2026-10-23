import { describe, expectTypeOf, it } from 'vitest'

import type { DurableLedger, LEDGER_FORMAT } from '../src'

/** Spells out intersections so the identity check compares shapes, not how a type was written. */
type Flat<T> = unknown extends T
  ? T
  : T extends bigint | string | number | boolean | null | undefined
    ? T
    : { [K in keyof T]: Flat<T[K]> }

type Resources = Readonly<Record<string, bigint>>
type Tx = { kind: 'tx'; to: string; data: string; value: bigint }
type Payload =
  | Tx
  | {
      kind: 'typed'
      domain: Readonly<{
        name?: string
        version?: string
        chainId?: bigint
        verifyingContract?: string
        salt?: string
      }>
      types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>
      primaryType: string
      message: Readonly<Record<string, unknown>>
    }
  | { kind: 'release'; channel: string; message: Readonly<Record<string, unknown>> }

type Format2 = {
  header: { format: 2; chainId: number; account: string; seq: number }
  nextNonce: number | null
  entries: Record<
    string,
    {
      spec: {
        id: string
        exposure: 'broadcast' | 'inclusion'
        resources: Resources
        expiry: bigint
        cap: bigint
        neutralizer: Tx
      }
      intentId: string
      validator: string
      creators: string[]
      deadCreators: string[]
      consumedFinal: bigint
      prior?: 'exposed' | 'live'
      neutralizing?: { nonce: number; hash: string }
      compensate: boolean
      state: 'exposed' | 'live' | 'revoking'
      origin: { payload: Payload; evidence?: unknown }
      affirmedBy: number
    }
  >
  nonces: Record<
    number,
    {
      nonce: number
      candidates: {
        hash: string
        raw: string
        payload: Tx
        kind: 'step' | 'neutralizer' | 'fill'
        intentId: string
        step: number
        creates: string[]
        exposes: string[]
        retires: string[]
        consumes: Resources
        feeLevel: number
        fee: bigint
        sent: 'unsent' | 'accepted' | 'unknown' | 'rejected' | 'withheld'
        authority?: {
          evidence: readonly {
            id: string
            version: string
            basis?: { block: number; blockHash: string }
          }[]
          decision?: Readonly<Record<string, string | number | boolean>>
        }
      }[]
      unknownSince?: number
      foreign?: true
    }
  >
  submissions: Record<
    string,
    { intentId: string; status: 'exposed' | 'settled' | 'compensated' | 'failed'; digest: string }
  >
  watermarks: Record<string, number>
  conflictMarks: [string, number][]
}

/** Each format's record shape as it shipped; an entry is never edited, only added under a new format. */
type Entry2 = Format2['entries'][string]

type Format3 = Omit<Format2, 'header' | 'entries'> & {
  header: { format: 3; chainId: number; account: string; seq: number }
  entries: Record<
    string,
    Omit<Entry2, 'origin'> & { origin: { payload: Payload; witness?: unknown } }
  >
}

type Nonce3 = Format3['nonces'][number]
type Candidate3 = Nonce3['candidates'][number]

type Format4 = Omit<Format3, 'header' | 'nonces'> & {
  header: { format: 4; chainId: number; account: string; seq: number }
  evidenceFloor: number
  releases: Record<string, { writes: string[]; after: number; restored?: true }>
  nonces: Record<
    number,
    Omit<Nonce3, 'candidates'> & {
      candidates: (Omit<Candidate3, 'authority'> & {
        writes: string[]
        authority?: {
          evidence: readonly {
            id: string
            version: string
            basis: { block: number; blockHash: string }
          }[]
          decision?: Readonly<Record<string, string | number | boolean>>
        }
      })[]
    }
  >
}

type ShippedFormats = { 2: Format2; 3: Format3; 4: Format4 }

describe('the durable ledger format', () => {
  it('names the record shape it writes, so a shape change cannot ship under an old format', () => {
    expectTypeOf<Flat<DurableLedger>>().toEqualTypeOf<Flat<ShippedFormats[typeof LEDGER_FORMAT]>>()
  })
})
