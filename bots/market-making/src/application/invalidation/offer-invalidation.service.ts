import type { Hex } from 'viem'

import { operatorErrorName } from '../operator-error-name.utils'
import { OfferInvalidationFailedError } from './offer-invalidation-failed.error'

/** One cancellation transaction observed immediately after wallet submission. */
export type OfferInvalidationTransactionSubmittedEvent = {
  event: 'offer-invalidation.transaction-submitted'
  groupId: Hex
  txHash: Hex
}

/** One group whose cancellation completed or was rendered in read-only mode. */
export type InvalidatedOfferGroup = {
  groupId: Hex
  txHash?: Hex
}

/** Successful result for an all-groups or explicitly selected invalidation request. */
export type OfferInvalidationSuccessReport = {
  status: 'applied' | 'logged'
  scope: 'all' | 'group'
  matchedGroups: number
  invalidatedGroups: readonly InvalidatedOfferGroup[]
}

/** Failed result retaining completed cancellations and sanitized remaining failures. */
export type OfferInvalidationFailureReport = {
  status: 'failed'
  scope: 'all' | 'group'
  matchedGroups: number
  invalidatedGroups: readonly InvalidatedOfferGroup[]
  failures: readonly {
    stage: 'preflight' | 'selection' | 'invalidation' | 'ownership-cleanup'
    groupId?: Hex
    errorName: string
    txHash?: Hex
  }[]
}

/** Consumer-owned cancellation capabilities required by the invalidation workflow. */
export interface OfferInvalidationPort {
  /** Reports whether cancellation is live or observational. @returns Writer or read-only mode. */
  mode(): 'write' | 'readonly'
  /** Validates the cancellation-specific provider and signer prerequisites. @returns Completion after safe preflight. */
  preflight(): Promise<void>
  /** Lists every currently active maker group. @returns Distinct active group IDs. */
  listActiveGroupIds(): Promise<readonly Hex[]>
  /**
   * Invalidates one maker group and waits for receipt confirmation.
   * @param groupId - Explicit bytes32 offer-group identifier.
   * @param onTransactionSubmitted - Optional observer called immediately after wallet submission.
   * @returns Confirmed transaction hash, or no hash in read-only mode.
   */
  invalidate(
    groupId: Hex,
    onTransactionSubmitted?: (txHash: Hex) => void | Promise<void>
  ): Promise<Hex | void>
  /**
   * Invalidates all selected groups in one native Midnight multicall.
   * @param groupIds - Distinct offer-group identifiers selected by the application.
   * @param onTransactionSubmitted - Optional observer called once after wallet submission.
   * @returns The confirmed shared transaction hash.
   * @throws An adapter error when submission or receipt confirmation fails.
   */
  invalidateBatch?(
    groupIds: readonly Hex[],
    onTransactionSubmitted?: (txHash: Hex) => void | Promise<void>
  ): Promise<Hex>
  /** Removes canceled bot-owned groups from durable ownership. @param groupIds - Confirmed canceled groups. @returns Completion after ownership cleanup. */
  forgetGroups(groupIds: readonly Hex[]): Promise<void>
}

/** Application workflow for explicit maker-wide or one-group offer invalidation. */
export class OfferInvalidationService {
  /** Creates the workflow. @param port - Cancellation-specific provider, signer, and ownership port. */
  constructor(private readonly port: OfferInvalidationPort) {}

  /**
   * Invalidates every active maker group or one explicitly selected group.
   * @param parameters - Optional group selector and immediate transaction observer.
   * @returns Applied or read-only result after every selected group is attempted.
   * @throws `OfferInvalidationFailedError` when preflight, selection, cancellation, receipt
   * confirmation, or ownership cleanup fails.
   * @remarks Omitting `groupId` enumerates the maker's complete active group set. Supplying it
   * directly targets that group even when the API has not indexed it and uses one `setConsumed` call.
   * Maker-wide write mode uses one native Midnight multicall, reports its shared hash against every
   * group, and never retries serially after submission. Observer failures never interrupt receipt
   * handling for an already-submitted transaction.
   */
  async run(
    parameters: {
      groupId?: Hex
      onTransactionSubmitted?: (
        event: OfferInvalidationTransactionSubmittedEvent
      ) => void | Promise<void>
    } = {}
  ): Promise<OfferInvalidationSuccessReport> {
    const scope = parameters.groupId ? 'group' : 'all'

    try {
      await this.port.preflight()
    } catch (error) {
      throw new OfferInvalidationFailedError({
        status: 'failed',
        scope,
        matchedGroups: 0,
        invalidatedGroups: [],
        failures: [
          {
            stage: 'preflight',
            ...(parameters.groupId ? { groupId: parameters.groupId } : {}),
            errorName: operatorErrorName(error)
          }
        ]
      })
    }

    let selectedGroupIds: Hex[]
    try {
      selectedGroupIds = parameters.groupId
        ? [parameters.groupId]
        : [...new Set(await this.port.listActiveGroupIds())]
    } catch (error) {
      throw new OfferInvalidationFailedError({
        status: 'failed',
        scope,
        matchedGroups: 0,
        invalidatedGroups: [],
        failures: [{ stage: 'selection', errorName: operatorErrorName(error) }]
      })
    }
    const invalidatedGroups: InvalidatedOfferGroup[] = []
    const failures: OfferInvalidationFailureReport['failures'][number][] = []

    if (
      scope === 'all' &&
      selectedGroupIds.length > 0 &&
      this.port.mode() === 'write' &&
      this.port.invalidateBatch
    ) {
      let submittedTxHash: Hex | undefined
      let batchTxHash: Hex
      try {
        batchTxHash = await this.port.invalidateBatch(selectedGroupIds, async hash => {
          submittedTxHash = hash
          await Promise.all(
            selectedGroupIds.map(async groupId => {
              try {
                await parameters.onTransactionSubmitted?.({
                  event: 'offer-invalidation.transaction-submitted',
                  groupId,
                  txHash: hash
                })
              } catch {
                // Diagnostic output cannot interrupt receipt handling after submission.
              }
            })
          )
        })
      } catch (error) {
        throw new OfferInvalidationFailedError({
          status: 'failed',
          scope,
          matchedGroups: selectedGroupIds.length,
          invalidatedGroups,
          failures: selectedGroupIds.map(groupId => ({
            stage: 'invalidation',
            groupId,
            errorName: operatorErrorName(error),
            ...(submittedTxHash ? { txHash: submittedTxHash } : {})
          }))
        })
      }

      invalidatedGroups.push(...selectedGroupIds.map(groupId => ({ groupId, txHash: batchTxHash })))
      try {
        await this.port.forgetGroups(selectedGroupIds)
      } catch (error) {
        failures.push(
          ...selectedGroupIds.map(groupId => ({
            stage: 'ownership-cleanup' as const,
            groupId,
            errorName: operatorErrorName(error),
            txHash: batchTxHash
          }))
        )
      }

      if (failures.length > 0) {
        throw new OfferInvalidationFailedError({
          status: 'failed',
          scope,
          matchedGroups: selectedGroupIds.length,
          invalidatedGroups,
          failures
        })
      }
      return {
        status: 'applied',
        scope,
        matchedGroups: selectedGroupIds.length,
        invalidatedGroups
      }
    }

    for (const groupId of selectedGroupIds) {
      let submittedTxHash: Hex | undefined
      let txHash: Hex | void

      try {
        txHash = await this.port.invalidate(groupId, async hash => {
          submittedTxHash = hash
          try {
            await parameters.onTransactionSubmitted?.({
              event: 'offer-invalidation.transaction-submitted',
              groupId,
              txHash: hash
            })
          } catch {
            // Diagnostic output cannot interrupt receipt handling after submission.
          }
        })
      } catch (error) {
        failures.push({
          stage: 'invalidation',
          groupId,
          errorName: operatorErrorName(error),
          ...(submittedTxHash ? { txHash: submittedTxHash } : {})
        })
        continue
      }

      invalidatedGroups.push({
        groupId,
        ...(txHash ? { txHash } : {})
      })
      try {
        await this.port.forgetGroups([groupId])
      } catch (error) {
        failures.push({
          stage: 'ownership-cleanup',
          groupId,
          errorName: operatorErrorName(error),
          ...(txHash ? { txHash } : {})
        })
      }
    }

    if (failures.length > 0) {
      throw new OfferInvalidationFailedError({
        status: 'failed',
        scope,
        matchedGroups: selectedGroupIds.length,
        invalidatedGroups,
        failures
      })
    }

    return {
      status: this.port.mode() === 'write' ? 'applied' : 'logged',
      scope,
      matchedGroups: selectedGroupIds.length,
      invalidatedGroups
    }
  }
}
