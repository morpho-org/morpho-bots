import { delay } from './delay'

export interface RetryOptions {
  maxRetries?: number
  retryDelay?: number
  onRetry?: (attempt: number, error?: unknown) => void
}

export async function retryUntilDefined<T>(
  fn: () => T | undefined,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 10, retryDelay = 500, onRetry } = options

  for (let i = 0; i < maxRetries; i++) {
    const result = fn()
    if (result !== undefined) return result

    if (i < maxRetries - 1) {
      onRetry?.(i + 1)
      await delay(retryDelay)
    }
  }

  throw new Error(`Value not defined after ${maxRetries} retries`)
}
