import type {
  DurableEntry,
  DurableLedger,
  EntryState,
  HeldState,
  KernelConfig,
  KernelState
} from './types'

import { HELD_STATES } from './types'

/** Any change to {@link DurableLedger}'s shape bumps this; a ledger in any other format is refused. */
export const LEDGER_FORMAT = 4

export const isHeld = (state: EntryState | undefined): state is HeldState =>
  HELD_STATES.some(held => held === state)

/** The projection of kernel state that survives a crash; everything else is rebuilt from the chain. */
export const toDurable = (state: KernelState, config: KernelConfig): DurableLedger => {
  const entries: Record<string, DurableEntry> = {}
  const quarter = Math.max(1, Math.floor(config.revokeAfterStaleMs / 4))
  for (const [id, entry] of Object.entries(state.entries)) {
    if (!isHeld(entry.state)) continue
    entries[id] = {
      spec: entry.spec,
      state: entry.state,
      intentId: entry.intentId,
      validator: entry.validator,
      creators: entry.creators,
      deadCreators: entry.deadCreators,
      origin: entry.origin!,
      consumedFinal: entry.consumedFinal,
      compensate: entry.compensate,
      affirmedBy: entry.affirmedAt - (entry.affirmedAt % quarter),
      ...(entry.prior ? { prior: entry.prior } : {}),
      ...(entry.neutralizing ? { neutralizing: entry.neutralizing } : {})
    }
  }
  const nonces: DurableLedger['nonces'] = {}
  for (const record of Object.values(state.nonces)) {
    nonces[record.nonce] = {
      nonce: record.nonce,
      candidates: record.candidates,
      ...(record.unknownSince === undefined ? {} : { unknownSince: record.unknownSince }),
      ...(record.foreign ? { foreign: true as const } : {})
    }
  }
  return {
    header: {
      format: LEDGER_FORMAT,
      chainId: config.chainId,
      account: config.account,
      seq: state.seq
    },
    nextNonce: state.nextNonce ?? null,
    entries,
    nonces,
    submissions: state.submissions,
    watermarks: state.watermarks,
    conflictMarks: Object.entries(state.conflictMarks).toSorted(([a], [b]) => (a < b ? -1 : 1)),
    evidenceFloor: state.evidenceFloor,
    releases: state.releases
  }
}

const BIGINT_TAG = '$bigint'
const INTEGER = /^-?\d+$/

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored key starting with `$` gains another, so a key with exactly one `$` is always a codec tag. */
const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() }
  if (!isObject(value) || !Object.keys(value).some(key => key.startsWith('$'))) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key.startsWith('$') ? `$${key}` : key, field])
  )
}

const reviver = (_key: string, value: unknown): unknown => {
  if (!isObject(value)) return value
  const keys = Object.keys(value)
  const tag = value[BIGINT_TAG]
  if (keys.length === 1 && typeof tag === 'string' && INTEGER.test(tag)) return BigInt(tag)
  if (!keys.some(key => key.startsWith('$'))) return value
  return Object.fromEntries(
    keys.map(key => {
      if (key.startsWith('$$')) return [key.slice(1), value[key]]
      if (key.startsWith('$')) throw new Error(`unknown codec tag ${key.slice(0, 40)}`)
      return [key, value[key]]
    })
  )
}

/** The on-disk codec: JSON with tagged bigints, so no two distinct storable values encode alike. */
export const encodeStored = (value: unknown): string => JSON.stringify(value, replacer)

/** Written tmp → fsync → rename → fsync dir. */
export const encodeLedger = (ledger: DurableLedger): string => encodeStored(ledger)

export const decodeLedger = (text: string): DurableLedger =>
  JSON.parse(text, reviver) as DurableLedger

/** A value exactly as it reads back from the ledger, or `undefined` when the codec cannot carry it. */
export const asStored = (value: unknown): { value: unknown } | undefined => {
  if (value === undefined) return { value }
  try {
    return { value: JSON.parse(JSON.stringify(value, replacer), reviver) as unknown }
  } catch {
    return undefined
  }
}

/** Tells a bigint apart from the tagged object the ledger codec writes for one. */
const plain = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? `bigint ${value.toString()}` : value

/** The encoding of `value` if it reads back through the ledger codec as itself, else undefined. */
export const storedText = (value: unknown) => {
  try {
    const text = JSON.stringify(value, replacer)
    const back = JSON.parse(text, reviver) as unknown
    return JSON.stringify(back, plain) === JSON.stringify(value, plain) ? text : undefined
  } catch {
    return undefined
  }
}
