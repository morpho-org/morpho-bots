export type YesNo = 'yes' | 'no'

/** Forces TS to recompute `T` -- similar to {@link Prettify} but simpler, for non-object types. */
export type Id<T> = T extends infer U ? U : never

export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export type Success<T> = {
  data: T
  error: null
}

export type Failure<E> = {
  data: null
  error: E
}

export type Result<T, E = string> = Success<T> | Failure<E>

/** Extracts union of keys from `T` whose values match type `V` */
export type KeysMatching<T, V> = {
  [K in keyof T]-?: T[K] extends V ? K : never
}[keyof T]

/** `T` if the condition is true, otherwise `Partial<T>` */
export type RequiredByCondition<T, Condition extends boolean | undefined> = Condition extends true
  ? T
  : Partial<T>

/** `T` if `T[Key]` is true, otherwise `Partial<T>` (runtime-discrimination compatible) */
export type RequiredByImplication<
  T,
  Key extends KeysMatching<T, boolean | undefined>,
  Base = Omit<T, Key>
> = (Base & { [K in Key]: true }) | (Partial<Base> & { [K in Key]?: false })

/** Creates a reverse mapping where values become keys and keys become values */
export type ReverseMapping<T extends Record<PropertyKey, PropertyKey>> = {
  [K in T[keyof T]]: {
    [P in keyof T]: T[P] extends K ? P : never
  }[keyof T]
}

/**
 * Recursively makes all properties in T required and non-nullable.
 * - Removes optional modifiers (`?`) from all properties
 * - Removes `null | undefined` from all property types
 * - Applies recursively to nested objects
 */
export type DeepRequired<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends object
    ? DeepRequired<NonNullable<T[K]>>
    : NonNullable<T[K]>
}

// oxlint-disable-next-line typescript/no-empty-object-type
export function typedEntries<T extends {}>(obj: T) {
  return Object.entries(obj) as {
    [K in keyof T]-?: [K, T[K]]
  }[keyof T][]
}

export function typedFromEntries<K extends PropertyKey, V>(
  entries: readonly (readonly [K, V])[]
): { [P in K]: V } {
  return Object.fromEntries(entries) as { [P in K]: V }
}
