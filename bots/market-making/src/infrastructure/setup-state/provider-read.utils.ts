import type { ProviderId, ProviderOperation } from './provider-read.error'

import { ProviderReadError } from './provider-read.error'

/**
 * Executes one provider read and replaces unknown rejection data with safe fixed metadata.
 * @param provider - Fixed provider identifier suitable for operator-visible reports.
 * @param operation - Stable operation code containing no request or response data.
 * @param read - Deferred third-party read to execute.
 * @returns The provider result when the read succeeds.
 * @throws `ProviderReadError` without retaining a raw message, URL, body, stack, or cause.
 */
export const executeProviderRead = async <Result>(
  provider: ProviderId,
  operation: ProviderOperation,
  read: () => Promise<Result>
): Promise<Result> => {
  try {
    return await read()
  } catch {
    throw new ProviderReadError(provider, operation)
  }
}
