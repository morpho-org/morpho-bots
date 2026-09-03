import type { PendingQueue, Signer } from '@repo/bot-kit'
import type { Address, Client, Hex } from 'viem'

import { initialFees } from '@repo/bot-kit'
import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

import type { PreparedResolution } from '../../domain/order-book'

import { ReadonlyMutationError } from './readonly-mutation.error'

export type ResolverSimulation =
  | { status: 'success'; data: Hex }
  | { status: 'revert'; reason: string }

export interface ResolverTransport {
  simulate(data: Hex): Promise<ResolverSimulation>
  submit(prepared: PreparedResolution): Promise<void>
}

export class ViemResolverTransport implements ResolverTransport {
  /**
   * Creates an RPC simulation transport with optional write capabilities.
   * @param client - Public chain client used for `eth_call`.
   * @param sender - Simulation caller and write-mode profit recipient.
   * @param resolver - Resolver contract target.
   * @param submission - Signer and queue dependencies; omission makes submission fail closed.
   */
  constructor(
    private readonly client: Client,
    private readonly sender: Address,
    private readonly resolver: Address,
    private readonly submission?: {
      queue: PendingQueue
      signer: Signer
      maxFeeWei: bigint
    }
  ) {}

  async simulate(data: Hex): Promise<ResolverSimulation> {
    const result = await tryCatch(
      call(this.client, {
        account: this.sender,
        to: this.resolver,
        data,
        value: 0n
      })
    )

    if (result.error) {
      return {
        status: 'revert',
        reason: result.error instanceof BaseError ? result.error.shortMessage : result.error.message
      }
    }
    if (!result.data.data) return { status: 'revert', reason: 'empty simulation result' }

    return { status: 'success', data: result.data.data }
  }

  /**
   * Queues the immutable request prepared by simulation.
   * @param prepared - Resolver target calldata and market label.
   * @returns A promise that resolves once the request is accepted by the queue.
   * @throws `ReadonlyMutationError` when submission dependencies were intentionally omitted.
   */
  async submit(prepared: PreparedResolution) {
    if (!this.submission) throw new ReadonlyMutationError()
    const fees = initialFees(await this.submission.signer.getBaseFee(), this.submission.maxFeeWei)

    await this.submission.queue.submit({
      request: { to: this.resolver, data: prepared.data },
      label: prepared.marketId,
      ...fees
    })
  }
}
