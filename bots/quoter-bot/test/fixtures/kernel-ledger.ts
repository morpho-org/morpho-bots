import type { Address } from 'viem'

import { LEDGER_FORMAT } from '@repo/kernel'
import { encodeLedger } from '@repo/kernel/testing'
import { zeroAddress } from 'viem'

const NO_CALL = { kind: 'tx', to: zeroAddress, data: '0x', value: 0n } as const

/** The part of a ledger entry a test cares about; the rest is filled in as the kernel would store it. */
type LedgerEntry = Readonly<{
  spec: Readonly<{ id: string }>
  state: 'exposed' | 'live'
  intentId: string
  origin: Readonly<{ witness: unknown }>
}>

/** A ledger file's text that the kernel's own validation accepts, holding `entries` for `account`. */
export const ledgerText = (chainId: number, account: Address, entries: readonly LedgerEntry[]) =>
  encodeLedger({
    header: { format: LEDGER_FORMAT, chainId, account, seq: 1 },
    nextNonce: null,
    entries: Object.fromEntries(
      entries.map(entry => [
        entry.spec.id,
        {
          ...entry,
          spec: {
            ...entry.spec,
            exposure: 'inclusion',
            resources: {},
            cap: 0n,
            expiry: 0n,
            neutralizer: NO_CALL
          },
          origin: { payload: NO_CALL, witness: entry.origin.witness },
          validator: 'test@1',
          creators: [],
          deadCreators: [],
          consumedFinal: 0n,
          compensate: false,
          affirmedBy: 0
        }
      ])
    ),
    nonces: {},
    submissions: {},
    watermarks: {},
    conflictMarks: [],
    evidenceFloor: 0,
    releases: {}
  } as never)
