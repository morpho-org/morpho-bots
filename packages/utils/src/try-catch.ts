// Reasoning: https://youtu.be/Y6jT-IkV0VM?si=zfipnVevAg0g7wrP
// Source: https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b

import { ensureError } from './errors'

export type Success<T> = {
  data: T
  error: null
}

export type Failure<E> = {
  data: null
  error: E
}

export type Result<T, E = string> = Success<T> | Failure<E>

// Main wrapper function
export function tryCatch<T, E extends Error = Error>(fn: () => T): Result<T, E>
export function tryCatch<T, E extends Error = Error>(fn: Promise<T>): Promise<Result<T, E>>
export function tryCatch<T, E extends Error = Error>(fn: Promise<T> | (() => T)) {
  const formatError = (e: unknown) => {
    const error = ensureError(e)
    return { data: null, error: error as E }
  }

  if (fn instanceof Promise) {
    return fn.then(data => ({ data, error: null })).catch(formatError)
  }

  try {
    return { data: fn(), error: null }
  } catch (e) {
    return formatError(e)
  }
}
