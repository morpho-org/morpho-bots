import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import type { LoanCollateral } from '../../domain/debt-ceiling'
import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { OfferCap } from '../../domain/offer-cap'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { OwnedLadderPublication } from '../../infrastructure/ladder/ladder-group-ownership.utils'
import type { MakerOfferGroup } from '../../infrastructure/provider/offer-groups.utils'
import type { LiveView } from './decision'
import type { Read } from './readings'

import { FailedReadError } from '../../errors'
import { adapterOperationField, operatorErrorName } from '../monitoring/operator-error-name.utils'

/** One accounting market's position and market state, both read at the world's block. */
export type WorldPosition = Readonly<{
  marketId: Hex
  credit: bigint
  debt: bigint
  loanCollateral?: LoanCollateral
  lossFactor: bigint
  maturity: bigint
  tickSpacing: number
  continuousFee: number
}>

/**
 * A buy group the kernel holds unretired, revoking and adopted ones included, with the cap its
 * offers were signed with: every such group reserves cash, whether or not a publication names it.
 */
export type HeldBuyGroup = Readonly<{ groupId: Hex; marketIds: readonly Hex[]; cap: OfferCap }>

/** What the maker holds, from the kernel's state and the publications this run submitted. */
export type WorldOwnership = Readonly<{
  ladderPublications: readonly OwnedLadderPublication[]
  /** Configured V0, this run's, and kernel-held bootstrap group IDs. */
  bootstrapGroupIds: readonly Hex[]
  bootstrapOffers: readonly (BootstrapOffer & {
    groupId: Hex
    tick?: bigint
    continuousFeeCap?: bigint
  })[]
  heldBuyGroups: readonly HeldBuyGroup[]
  /**
   * Units-capped buy groups the kernel retired: each was neutralized, filled, expired, or never
   * created, proven at finality, so none can be taken again and none reserves cash or credit.
   */
  retiredGroupIds: readonly Hex[]
}>

/**
 * One poll of everything the quoter decides from, as one decision key sees it, without the block it
 * was read at: a failed read is a failed value, never a missing one.
 */
export type WorldValue = Readonly<{
  strategy: 'ladder' | 'bootstrap'
  marketId: Hex
  ownership: WorldOwnership
  /** The market's own live book, read with `ownership`. */
  view: LiveView
  groups: Read<readonly MakerOfferGroup[]>
  /** Every accounting (`setup.marketIds`) market's position, by market ID. */
  positions: Readonly<Record<Hex, Read<WorldPosition>>>
  cash: Read<Readonly<{ cashBalance: bigint; allowance: bigint }>>
  /** Protocol consumption of every group the poll knows of, by exact group ID. */
  consumed: Read<Readonly<Record<string, bigint>>>
  /** A ladder market's takeable book; `null` when the response could not be used as an observation. */
  book?: Read<readonly OwnedOverlapBookOffer[] | null>
}>

/** A {@link WorldValue} with the block and block timestamp every chain value of it was read at. */
export type WorldReading = WorldValue & Readonly<{ block: number; timestamp: bigint }>

/**
 * One preparation's own read of one market: the ownership projection, the maker's offer groups and
 * the market's book from the API, and the market and every known group's consumption at `block`.
 */
export type PreparationReading = Readonly<{
  block: Readonly<{ number: bigint; timestamp: bigint }>
  ownership: WorldOwnership
  groups: readonly MakerOfferGroup[]
  book: readonly OwnedOverlapBookOffer[]
  market: IMarket
  consumed: Readonly<Record<string, bigint>>
}>

/** What a world derivation needs from configuration beyond the market's own strategy. */
export type WorldAccounting = Readonly<{
  maker: Hex
  marketIds: readonly Hex[]
  acceptedLossFactor?: ReadonlyMap<Hex, bigint>
  v0OfferGroupIds: readonly Hex[]
}>

const ADAPTER_ERRORS = new Set(['LadderAdapterError', 'BootstrapAdapterError'])

/**
 * A shared read's failure as the strategy reading it names it: each strategy's own readers reported
 * adapter failures as that strategy's adapter error.
 * @param read - A read shared by both strategies.
 * @param strategy - The strategy taking the read.
 * @returns The read, with a shared adapter error renamed to the strategy's own.
 */
export const strategyRead = <T>(read: Read<T>, strategy: WorldReading['strategy']): Read<T> =>
  read.ok || !ADAPTER_ERRORS.has(read.errorName)
    ? read
    : {
        ...read,
        errorName: strategy === 'ladder' ? 'LadderAdapterError' : 'BootstrapAdapterError'
      }

/**
 * A read's value; a failed read fails the {@link derive} it is taken in with that same failure.
 * @param read - The read to unwrap.
 * @returns The read's value.
 * @throws `FailedReadError` carrying the failed read.
 */
export const valueOf = <T>(read: Read<T>): T => {
  if (!read.ok) throw new FailedReadError(read)
  return read.value
}

/**
 * Runs a pure derivation, keeping a failure as a value named as the readers named it.
 * @param compute - Pure derivation; it may throw, including through {@link valueOf}.
 * @returns The computed value, or the failure as an operator-safe failed read; never throws.
 */
export const derive = <T>(compute: () => T): Read<T> => {
  try {
    return { ok: true, value: compute() }
  } catch (error) {
    if (error instanceof FailedReadError) return error.failure
    return { ok: false, errorName: operatorErrorName(error), ...adapterOperationField(error) }
  }
}
