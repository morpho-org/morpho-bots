// Reasoning: https://youtu.be/Y6jT-IkV0VM?si=zfipnVevAg0g7wrP
// Source: https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b

import type { Result } from '../types/index'

import { ensureError } from './errors'

// Main wrapper function
export function tryCatch<T, E extends Error = Error>(fn: () => T): Result<T, E>
export function tryCatch<T, E extends Error = Error>(fn: Promise<T>): Promise<Result<T, E>>
export function tryCatch<T, E extends Error = Error>(fn: Promise<T> | (() => T)) {
  const formatError = (e: unknown) => {
    const error = ensureError(e)
    return { data: null, error: error as E }
  }

  // Branch on callable, not on `instanceof Promise`: a thenable that is not a native Promise — most
  // notably execa's subprocess, which its own typings declare as `extends Promise<Result>` — would
  // otherwise fall through to the sync path and be *called*, turning every such await into a
  // `fn is not a function` failure that reads like the awaited operation itself failed.
  // `Promise.resolve` assimilates a thenable and passes a real Promise straight through.
  if (typeof fn === 'function') {
    try {
      return { data: fn(), error: null }
    } catch (e) {
      return formatError(e)
    }
  }

  return Promise.resolve(fn)
    .then(data => ({ data, error: null }))
    .catch(formatError)
}
