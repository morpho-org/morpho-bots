import type { Authority, DecisionRecord, DurableLedger, Fact } from './types'

import { isObject, LEDGER_FORMAT, storedText } from './durable'
import { HELD_STATES } from './types'

type Check = (value: unknown, at: string) => string | undefined

/** Calldata as the signer takes it: `0x` and whole bytes. Anything looser could decode one way and sign another. */
export const isCalldata = (v: unknown): v is string =>
  typeof v === 'string' && /^0x(?:[\da-f]{2})*$/i.test(v)

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const isNat = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
const isAmount = (v: unknown) => typeof v === 'bigint' && v >= 0n
const isStrings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
const isResources = (v: unknown) => isObject(v) && Object.values(v).every(isAmount)
const oneOf = (v: unknown, options: readonly string[]) =>
  typeof v === 'string' && options.includes(v)

const txPayload: Check = (v, at) => {
  if (!isObject(v) || v.kind !== 'tx' || typeof v.to !== 'string' || !isAmount(v.value))
    return `${at} is not a transaction payload`
  return isCalldata(v.data) ? undefined : `${at}: calldata is not whole bytes of hex`
}

/** Why a value is not a payload the kernel can read, or `undefined` when it is one. */
export const payloadDefect: Check = (v, at) => {
  if (!isObject(v)) return `${at} is not a payload`
  if (v.kind === 'tx') return txPayload(v, at)
  if (v.kind === 'typed')
    return isObject(v.domain) &&
      isObject(v.types) &&
      typeof v.primaryType === 'string' &&
      isObject(v.message)
      ? undefined
      : `${at} is not a typed-data payload`
  if (v.kind === 'release')
    return typeof v.channel === 'string' && isObject(v.message)
      ? undefined
      : `${at} is not a release payload`
  return `${at} is not a payload`
}

/** The first rule that does not hold names the defect; rules are evaluated in order. */
const firstBroken = (rules: readonly (readonly [boolean | (() => boolean), string])[]) => {
  for (const [holds, defect] of rules)
    if (!(typeof holds === 'function' ? holds() : holds)) return defect
  return undefined
}

const entry = (v: unknown, id: string): string | undefined => {
  const at = `entry ${id}`
  if (!isObject(v) || !isObject(v.spec)) return `${at} is not an entry`
  const { spec } = v
  const n = v.neutralizing
  return (
    firstBroken([
      [spec.id === id, `${at} is stored under another id`],
      [oneOf(v.state, HELD_STATES), `${at} has a state the ledger never persists`],
      [oneOf(spec.exposure, ['broadcast', 'inclusion']), `${at} has no exposure mode`],
      [
        isResources(spec.resources) &&
          isAmount(spec.cap) &&
          isAmount(spec.expiry) &&
          isAmount(v.consumedFinal),
        `${at} has malformed amounts`
      ]
    ]) ??
    txPayload(spec.neutralizer, `${at} neutralizer`) ??
    (isObject(v.origin)
      ? payloadDefect(v.origin.payload, `${at} origin`)
      : `${at} has no creating payload`) ??
    firstBroken([
      [typeof v.intentId === 'string' && typeof v.validator === 'string', `${at} has no origin`],
      [isStrings(v.creators) && isStrings(v.deadCreators), `${at} has malformed creators`],
      [
        typeof v.compensate === 'boolean' && Number.isFinite(v.affirmedBy),
        `${at} has malformed obligations`
      ],
      [
        v.prior === undefined || oneOf(v.prior, ['exposed', 'live']),
        `${at} has a malformed prior state`
      ],
      [
        n === undefined || (isObject(n) && isNat(n.nonce) && typeof n.hash === 'string'),
        `${at} has a malformed neutralizer reference`
      ],
      [
        (v.state === 'revoking') === (n !== undefined),
        `${at} is revoking without a neutralizer, or the reverse`
      ]
    ])
  )
}

/** The most fields, and the longest string, a decision record may hold. */
const DECISION_FIELDS = 16
const DECISION_NAME = 64
const DECISION_TEXT = 256
/** The longest a candidate's authority may encode to, so a record never bloats the ledger. */
const AUTHORITY_TEXT = 4_096

const CONFLICT_ID_LENGTH = 256

/** Names an untrusted value in a refusal without serializing it, which can throw. */
const describe = (value: unknown) =>
  typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : `of type ${typeof value}`
const isControl = (code: number) => code < 0x20 || code === 0x7f

/** A conflict id indexes the durable marks, so one that names an inherited property is refused. */
const conflictIdDefect = (id: unknown): string | undefined =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= CONFLICT_ID_LENGTH &&
  !Array.from({ length: id.length }, (_, i) => id.charCodeAt(i)).some(isControl) &&
  !(id in Object.prototype)
    ? undefined
    : `conflict id ${describe(id)} is not a short printable name`

export const conflictsDefect = (conflicts: unknown): string | undefined => {
  if (conflicts === undefined) return undefined
  if (!isObject(conflicts)) return 'conflicts are not reads and writes'
  for (const side of [conflicts.reads, conflicts.writes]) {
    if (side === undefined) continue
    if (!Array.isArray(side)) return 'conflicts are not reads and writes'
    for (const id of side as unknown[]) {
      const defect = conflictIdDefect(id)
      if (defect) return defect
    }
  }
  return undefined
}

const writesDefect = (writes: unknown, at: string): string | undefined => {
  const defect = Array.isArray(writes) ? conflictsDefect({ writes }) : 'not a list'
  return defect ? `${at} has malformed conflict writes: ${defect}` : undefined
}

const marksDefect = (marks: unknown): string | undefined => {
  if (!Array.isArray(marks)) return 'missing sections'
  const seen = new Set<string>()
  for (const pair of marks as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isNat(pair[1]))
      return 'malformed conflict marks'
    const defect = conflictIdDefect(pair[0])
    if (defect) return `malformed conflict marks: ${defect}`
    if (seen.has(pair[0] as string)) return 'malformed conflict marks: a conflict id recorded twice'
    seen.add(pair[0] as string)
  }
  return undefined
}

/** What a candidate records of its plan's authorization, in the shape the ledger persists it. */
export const recordedAuthority = (
  evidence: readonly Fact[] | undefined,
  decision: DecisionRecord | undefined
): Authority | undefined =>
  evidence || decision ? { evidence: evidence ?? [], ...(decision ? { decision } : {}) } : undefined

/** An array with exactly its own elements and length, so every method it is read with is the built-in. */
const isPlainList = (v: unknown): v is unknown[] =>
  Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype &&
  Reflect.ownKeys(v).every((key, i) => key === (i < v.length ? String(i) : 'length'))

/**
 * Why a plan's evidence and decision record cannot be stored and read back, or undefined. A fact
 * with no basis passes: a recorded authority authorizes nothing again, so the ledger keeps loading.
 */
export const authorityDefect = (evidence: unknown, decision: unknown): string | undefined => {
  if (evidence !== undefined) {
    if (!isPlainList(evidence)) return 'evidence is not a list'
    for (const fact of evidence) {
      if (!isObject(fact) || typeof fact.id !== 'string' || typeof fact.version !== 'string')
        return 'evidence names no fact'
      const { basis } = fact
      if (
        basis !== undefined &&
        !(isObject(basis) && isNat(basis.block) && typeof basis.blockHash === 'string')
      )
        return 'evidence basis is not a block'
    }
  }
  if (decision !== undefined) {
    const fields = isObject(decision) ? Object.entries(decision) : undefined
    const scalar = ([name, field]: [string, unknown]) =>
      name.length <= DECISION_NAME &&
      (typeof field === 'boolean' ||
        (typeof field === 'number' && Number.isFinite(field)) ||
        (typeof field === 'string' && field.length <= DECISION_TEXT))
    if (!fields || fields.length > DECISION_FIELDS || !fields.every(scalar))
      return 'decision record is not a few named scalars'
  }
  const recorded = recordedAuthority(
    evidence as readonly Fact[] | undefined,
    decision as DecisionRecord | undefined
  )
  if (recorded === undefined) return undefined
  const text = storedText(recorded)
  if (text === undefined) return 'authority does not read back from the ledger as itself'
  return text.length > AUTHORITY_TEXT ? 'authority is too large to record' : undefined
}

const authority = (v: unknown, at: string): string | undefined => {
  if (v === undefined) return undefined
  if (!isObject(v) || !Array.isArray(v.evidence)) return `${at} has a malformed authority`
  const defect = authorityDefect(v.evidence, v.decision)
  return defect ? `${at}: ${defect}` : undefined
}

const candidate = (v: unknown, at: string): string | undefined => {
  if (!isObject(v) || typeof v.hash !== 'string' || typeof v.raw !== 'string')
    return `${at} is not a candidate`
  return (
    txPayload(v.payload, `${at} payload`) ??
    authority(v.authority, at) ??
    writesDefect(v.writes, at) ??
    firstBroken([
      [
        oneOf(v.kind, ['step', 'neutralizer', 'fill']) &&
          typeof v.intentId === 'string' &&
          isNat(v.step),
        `${at} has no origin`
      ],
      [
        isStrings(v.creates) &&
          isStrings(v.exposes) &&
          isStrings(v.retires) &&
          isResources(v.consumes),
        `${at} has a malformed reading`
      ],
      [
        isNat(v.feeLevel) &&
          isAmount(v.fee) &&
          oneOf(v.sent, ['unsent', 'accepted', 'unknown', 'rejected', 'withheld']),
        `${at} has a malformed send status`
      ]
    ])
  )
}

/** Checks every nonce record and returns where each candidate hash is recorded. */
const nonceRecords = (
  nonces: Record<string, unknown>,
  nextNonce: unknown
): Map<string, number> | string => {
  const hashes = new Map<string, number>()
  for (const [key, record] of Object.entries(nonces)) {
    if (!isObject(record) || String(record.nonce) !== key || !isNat(record.nonce)) {
      return `nonce record ${key} is stored under another nonce`
    }
    const nonce = record.nonce as number
    const bad = firstBroken([
      [
        isNat(nextNonce) && nonce < (nextNonce as number),
        `nonce record ${key} is at or above the next nonce`
      ],
      [Array.isArray(record.candidates), `nonce record ${key} has no candidates list`],
      [
        record.unknownSince === undefined || isNat(record.unknownSince),
        `nonce record ${key} has a malformed latch age`
      ],
      [
        record.foreign === undefined || record.foreign === true,
        `nonce record ${key} has a malformed foreign flag`
      ]
    ])
    if (bad) return bad
    for (const [i, c] of (record.candidates as unknown[]).entries()) {
      const malformed = candidate(c, `candidate ${key}.${i}`)
      if (malformed) return malformed
      const hash = (c as { hash: string }).hash
      if (hashes.has(hash)) return `candidate ${hash} is recorded twice`
      hashes.set(hash, nonce)
    }
  }
  return hashes
}

const submission = (sid: string, sub: unknown) =>
  isObject(sub) && typeof sub.intentId === 'string' && typeof sub.digest === 'string'
    ? oneOf(sub.status, ['exposed', 'settled', 'compensated', 'failed'])
      ? undefined
      : `submission ${sid} has an unknown status`
    : `submission ${sid} is malformed`

/**
 * Accepts a parsed ledger only if every record is well-formed and the records agree with each other;
 * the kernel refuses to start on anything else rather than reading a partial ledger as less exposure.
 */
export const validateLedger = (
  v: unknown,
  expected: { chainId: number; account: string }
): DurableLedger | string => {
  const fail = (why: string) => `malformed ledger: ${why}`
  if (!isObject(v) || !isObject(v.header)) return fail('not a ledger')
  const { header, entries, nonces, submissions, watermarks, releases } = v
  const shape = firstBroken([
    [header.format === LEDGER_FORMAT, 'unknown format'],
    [
      header.chainId === expected.chainId &&
        typeof header.account === 'string' &&
        sameAddress(header.account, expected.account),
      'bound to another chain or account'
    ],
    [isNat(header.seq), 'bad sequence number'],
    [v.nextNonce === null || isNat(v.nextNonce), 'bad next nonce'],
    [isNat(v.evidenceFloor), 'bad evidence floor'],
    [[entries, nonces, submissions, watermarks, releases].every(isObject), 'missing sections']
  ])
  if (shape) return fail(shape)
  const keys = [entries, nonces, submissions, watermarks, releases].flatMap(section =>
    Object.keys(section as object)
  )
  const inherited = keys.find(key => key in Object.prototype)
  if (inherited !== undefined) return fail(`record ${inherited} names an inherited property`)
  const hashes = nonceRecords(nonces as Record<string, unknown>, v.nextNonce)
  if (typeof hashes === 'string') return fail(hashes)
  for (const [id, e] of Object.entries(entries as Record<string, unknown>)) {
    const bad = entry(e, id)
    if (bad) return fail(bad)
    const n = (e as { neutralizing?: { nonce: number; hash: string } }).neutralizing
    if (n && hashes.get(n.hash) !== n.nonce)
      return fail(`entry ${id} names a neutralizing candidate that is not recorded`)
  }
  for (const [sid, sub] of Object.entries(submissions as Record<string, unknown>)) {
    const bad = submission(sid, sub)
    if (bad) return fail(bad)
  }
  if (!Object.values(watermarks as Record<string, unknown>).every(isNat))
    return fail('malformed watermarks')
  const marks = marksDefect(v.conflictMarks)
  if (marks) return fail(marks)
  for (const [intentId, release] of Object.entries(releases as Record<string, unknown>)) {
    const bad = releaseDefect(release, `release ${intentId}`)
    if (bad) return fail(bad)
  }
  return v as DurableLedger
}

const releaseDefect = (release: unknown, at: string) =>
  isObject(release) &&
  isNat(release.after) &&
  (release.restored === undefined || release.restored === true)
    ? writesDefect(release.writes, at)
    : `${at} is malformed`
