import { NotDataError } from './errors'

/**
 * What a node may hold: JSON plus bigint. Object fields that are `undefined` are dropped, so `{ a:
 * undefined }` and `{}` are the same value.
 */
export type Data =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly Data[]
  | { readonly [field: string]: Data | undefined }

const BIGINT_FIELD = '$bigint'

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const encodeObject = (value: object, path: string): string => {
  if (!isPlainObject(value)) throw new NotDataError(path, 'is not a plain object')
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
  return `{${fields
    .map(([name, field]) => {
      if (name === BIGINT_FIELD) throw new NotDataError(path, `uses the reserved field ${name}`)
      return `${JSON.stringify(name)}:${encodeAt(field, `${path}.${name}`)}`
    })
    .join(',')}}`
}

const encodeAt = (value: unknown, path: string): string => {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotDataError(path, 'is not a finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') return `{"${BIGINT_FIELD}":"${value}"}`
  if (value === null) return 'null'
  if (typeof value !== 'object') throw new NotDataError(path, `is ${typeof value}`)
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item, index) => encodeAt(item, `${path}[${index}]`)).join(',')}]`
  }
  return encodeObject(value, path)
}

/**
 * The canonical text of a value: equal data always encodes the same way, so two encodings compare
 * equal exactly when the values do. Throws {@link NotDataError} for anything else.
 */
export const encode = (value: unknown) => encodeAt(value, '')

/** Validates a value as data and freezes every container before returning it. */
export const freezeData = (value: unknown): Data => {
  encode(value)
  const freeze = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) return
    for (const field of Object.values(item)) freeze(field)
    if (!Object.isFrozen(item)) Object.freeze(item)
  }
  freeze(value)
  return value as Data
}

const reviveBigint = (_field: string, value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const fields = Object.keys(value)
  if (fields.length !== 1 || fields[0] !== BIGINT_FIELD) return value
  const digits = (value as Record<string, unknown>)[BIGINT_FIELD]
  return typeof digits === 'string' ? BigInt(digits) : value
}

export const decode = (text: string): Data => JSON.parse(text, reviveBigint)
