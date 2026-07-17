/**
 * Transforms an object by applying `fn` to each of its values, leaving keys alone.
 *
 * @example
 * ```
 * const x = { a: 1, b: 2, c: 3}
 * const y = mapObjValues(x, (v) => v * 2) // { a: 2, b: 4, c: 6 }
 * ```
 */
export function mapObjValues<T extends object, U>(
  obj: T,
  fn: (value: T[keyof T], key: keyof T) => U
): { [K in keyof T]: U } {
  const result = {} as { [K in keyof T]: U }
  const keys = Reflect.ownKeys(obj) as (keyof T)[]
  for (const k of keys) result[k] = fn(obj[k], k)
  return result
}

/**
 * Filters out null values from an array and returns a type-safe array
 */
export function filterNull<T>(arr: (T | null)[]): T[] {
  return arr.filter(item => item !== null) as T[]
}
