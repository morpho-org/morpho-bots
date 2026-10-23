import type { TxPayload } from '../src'

/**
 * The reference encoding: canonical JSON of `{fn, args}` as calldata. It stands in for an ABI so the
 * reference validators read the same bytes that are signed, as production validators decode theirs.
 */
type Call = { fn: string; args: Readonly<Record<string, unknown>> }

const replacer = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? { $bigint: value.toString() } : value

const reviver = (_key: string, value: unknown) =>
  typeof value === 'object' && value !== null && '$bigint' in value
    ? BigInt((value as { $bigint: string }).$bigint)
    : value

export const encodeCall = (
  to: string,
  fn: string,
  args: Readonly<Record<string, unknown>> = {},
  value = 0n
): TxPayload => ({
  kind: 'tx',
  to,
  data: `0x${Buffer.from(JSON.stringify({ fn, args }, replacer), 'utf8').toString('hex')}`,
  value
})

/** The call a payload encodes, or `undefined` for calldata the reference encoding cannot read. */
export const decodeCall = (payload: TxPayload): Call | undefined => {
  if (!/^0x(?:[\da-f]{2})*$/i.test(payload.data)) return undefined
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload.data.slice(2), 'hex').toString('utf8'),
      reviver
    )
    if (typeof decoded !== 'object' || decoded === null) return undefined
    const { fn, args } = decoded as Record<string, unknown>
    if (typeof fn !== 'string' || typeof args !== 'object' || args === null) return undefined
    return { fn, args: args as Record<string, unknown> }
  } catch {
    return undefined
  }
}

export const fnOf = (payload: { kind: string } | undefined) =>
  payload?.kind === 'tx' ? decodeCall(payload as TxPayload)?.fn : undefined

export const argsOf = (payload: { kind: string } | undefined) =>
  payload?.kind === 'tx' ? (decodeCall(payload as TxPayload)?.args ?? {}) : {}
