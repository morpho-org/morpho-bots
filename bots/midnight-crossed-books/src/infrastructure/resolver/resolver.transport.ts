import type { PendingQueue, Signer } from '@repo/bot-kit'
import type { Address, Client, Hex } from 'viem'

import { initialFees } from '@repo/bot-kit'
import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

import type { PreparedResolution } from '../../domain/order-book'

export type ResolverSimulation =
  | { status: 'success'; data: Hex }
  | { status: 'revert'; reason: string }

export interface ResolverTransport {
  simulate(data: Hex): Promise<ResolverSimulation>
  submit(prepared: PreparedResolution, blockNumber: bigint): Promise<void>
}

export class ViemResolverTransport implements ResolverTransport {
  constructor(
    private readonly client: Client,
    private readonly sender: Address,
    private readonly resolver: Address,
    private readonly queue: PendingQueue,
    private readonly signer: Signer,
    private readonly maxFeeWei: bigint
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

  async submit(prepared: PreparedResolution, blockNumber: bigint) {
    const fees = initialFees(await this.signer.getBaseFee(), this.maxFeeWei)

    await this.queue.submit({
      request: { to: this.resolver, data: prepared.data },
      label: prepared.marketId,
      ...fees,
      blockNumber
    })
  }
}
