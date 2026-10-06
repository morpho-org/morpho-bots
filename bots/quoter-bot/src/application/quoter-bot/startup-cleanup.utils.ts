import type { Hex } from 'viem'

import type { BootstrapMakeResult } from '../bootstrap/position-bootstrap-verbose'
import type { LadderMakeResult } from '../ladder/ladder-verbose'

import { isBytes32, normalizeBytes32 } from '../../domain/bytes32'
import { BootstrapHardHaltError } from '../../infrastructure/bootstrap/bootstrap-hard-halt.error'
import { LadderHardHaltError } from '../../infrastructure/ladder/ladder-hard-halt.error'
import { adapterOperationField, operatorErrorName } from '../monitoring/operator-error-name.utils'
import { StartupCleanupFailedError } from './startup-cleanup-failed.error'

type StrategyCleanup = () => Promise<{ cleanup(): Promise<BootstrapMakeResult | LadderMakeResult> }>

type ConfirmedTransaction = { operation: 'cancel' | 'ratify' | 'publish'; txHash: Hex }

type StrategyCleanupOutcome =
  | { status: 'succeeded'; transactions: readonly ConfirmedTransaction[] }
  | {
      status: 'failed'
      errorName: string
      adapterOperation?: string
      /** Groups whose cleanup did not complete; absent when ownership could not be enumerated. */
      unresolvedGroupIds?: readonly Hex[]
    }

/** Sanitized evidence that a writer startup failed and its owned-offer cleanup did not complete. */
export type StartupCleanupReport = {
  reason: 'startup-cleanup-failed'
  errorName: string
  adapterOperation?: string
  ladder: StrategyCleanupOutcome
  bootstrap: StrategyCleanupOutcome
}

const OPERATIONS: ReadonlySet<string> = new Set(['cancel', 'ratify', 'publish'])

const confirmedTransactions = (result: unknown): ConfirmedTransaction[] => {
  if (typeof result !== 'object' || result === null) return []
  const submitted = (result as { submittedTransactions?: unknown }).submittedTransactions
  if (!Array.isArray(submitted)) return []
  return submitted.flatMap((entry: { operation?: unknown; txHash?: unknown }) =>
    typeof entry?.operation === 'string' &&
    OPERATIONS.has(entry.operation) &&
    typeof entry.txHash === 'string' &&
    isBytes32(entry.txHash)
      ? [
          {
            operation: entry.operation as ConfirmedTransaction['operation'],
            txHash: normalizeBytes32(entry.txHash)
          }
        ]
      : []
  )
}

const unresolvedGroupIds = (error: unknown) => {
  if (!(error instanceof LadderHardHaltError || error instanceof BootstrapHardHaltError)) return {}
  return {
    unresolvedGroupIds: error.failures.flatMap((failure: { groupId?: unknown }) =>
      typeof failure?.groupId === 'string' && isBytes32(failure.groupId)
        ? [normalizeBytes32(failure.groupId)]
        : []
    )
  }
}

const runCleanup = async (strategy: StrategyCleanup): Promise<StrategyCleanupOutcome> => {
  try {
    return {
      status: 'succeeded',
      transactions: confirmedTransactions(await (await strategy()).cleanup())
    }
  } catch (error) {
    return {
      status: 'failed',
      errorName: operatorErrorName(error),
      ...adapterOperationField(error),
      ...unresolvedGroupIds(error)
    }
  }
}

const isOperatorAbort = (signal: AbortSignal, error: unknown) =>
  signal.aborted && error instanceof Error && error.name === 'AbortError'

/**
 * Runs a writer's startup and, if it throws, cancels every offer both strategies durably own first.
 * @param parameters - Shutdown signal, both strategies' cleanup ports, and the terminal event writer.
 * @param startup - Fallible startup steps that follow signer verification.
 * @returns The startup result.
 * @throws The original startup error once cleanup confirms, or `StartupCleanupFailedError` when any
 * strategy's cleanup fails. An operator abort is rethrown without cleanup.
 * @remarks Cleanups run sequentially so they share the signer nonce, and each runs even if the other
 * fails.
 */
export const cancelOwnedOffersOnStartupFailure = async <T>(
  parameters: {
    signal: AbortSignal
    ladder: StrategyCleanup
    bootstrap: StrategyCleanup
    writeEvent?: (value: unknown) => void | Promise<void>
  },
  startup: () => Promise<T>
): Promise<T> => {
  try {
    return await startup()
  } catch (error) {
    if (isOperatorAbort(parameters.signal, error)) throw error
    const cause = { errorName: operatorErrorName(error), ...adapterOperationField(error) }
    const ladder = await runCleanup(parameters.ladder)
    const bootstrap = await runCleanup(parameters.bootstrap)
    if (ladder.status === 'failed' || bootstrap.status === 'failed') {
      throw new StartupCleanupFailedError({
        reason: 'startup-cleanup-failed',
        ...cause,
        ladder,
        bootstrap
      })
    }
    await (async () =>
      parameters.writeEvent?.({
        event: 'startup.owned-offers-cancelled',
        ...cause,
        ladder,
        bootstrap
      }))().catch(() => undefined)
    throw error
  }
}
