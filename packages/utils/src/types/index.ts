/** Forces TS to recompute `T` -- useful for collapsing a mapped type back to a readable alias. */
export type Id<T> = T extends infer U ? U : never

export type Success<T> = {
  data: T
  error: null
}

export type Failure<E> = {
  data: null
  error: E
}

export type Result<T, E = string> = Success<T> | Failure<E>
