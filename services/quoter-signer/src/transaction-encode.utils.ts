import type { Address, Hex } from 'viem'

import {
  ecrecoverRatifierAbi,
  MAX_OFFER_CAP,
  midnightAbi,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { encodeFunctionData } from 'viem'

import type { RevokeOperation } from './intent.utils'
import type { QuoterSignerPolicy } from './policy.utils'

/**
 * One canonically encoded zero-value contract call — the target and calldata the middleware
 * itself built from a validated intent and its deployment pins. Callers never supply targets,
 * selectors, or calldata (TIB-2026-08-12 sign-what-you-encode).
 */
export type EncodedContractCall = {
  /** Policy-pinned target contract. */
  readonly to: Address
  /** Middleware-encoded calldata. */
  readonly data: Hex
}

const consumeGroupCall = (group: Hex, maker: Address): Hex =>
  // The exact TIB-2026-08-12 revoke shape: consume the group to the protocol cap with the pinned
  // maker as `onBehalf`, so the signed transaction can only reduce the maker's own exposure.
  encodeFunctionData({
    abi: midnightAbi,
    functionName: 'setConsumed',
    args: [group, MAX_OFFER_CAP, maker]
  })

/**
 * Encodes the group-consumption call for one or more maker-owned offer groups on the pinned
 * Midnight singleton: a single `setConsumed(group, MAX_OFFER_CAP, maker)`, or one `multicall`
 * whose inner calls are exclusively such consumptions. The middleware builds every inner call
 * itself from validated bytes32 group ids, so no other selector — including a nested `multicall`
 * — can appear in the batch by construction; the wire contract already rejects empty batches.
 * @param groups - Validated, non-empty offer-group ids to consume.
 * @param policy - Parsed deployment policy supplying the maker and singleton pins.
 * @returns The encoded zero-value call targeting the pinned singleton.
 */
export const encodeConsumeGroupsCall = (
  groups: readonly Hex[],
  policy: QuoterSignerPolicy
): EncodedContractCall => {
  const calls = groups.map(group => consumeGroupCall(group, policy.maker))
  return {
    to: policy.contracts.midnight,
    data:
      calls.length === 1 && calls[0] !== undefined
        ? calls[0]
        : encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [calls] })
  }
}

/**
 * A revoke operation this build's encoder supports — everything but `self-cancel`, which needs
 * the recorded-transaction validation of a later TIB increment.
 */
export type EncodableRevokeOperation = Exclude<RevokeOperation, { readonly type: 'self-cancel' }>

/**
 * Encodes one revoke operation into its exact allowlisted call: group consumption on the pinned
 * singleton, `cancelRoot(maker, root)` on the pinned Ecrecover ratifier, or
 * `setIsRootRatified(maker, root, false)` on the pinned Setter ratifier. Ratifier-mode coherence
 * was already enforced by the policy-check stage; `self-cancel` never reaches this encoder.
 * @param operation - Validated revoke operation (never `self-cancel`).
 * @param policy - Parsed deployment policy supplying the maker, singleton, and ratifier pins.
 * @returns The encoded zero-value call for the operation.
 */
export const encodeRevokeOperationCall = (
  operation: EncodableRevokeOperation,
  policy: QuoterSignerPolicy
): EncodedContractCall => {
  if (operation.type === 'consume-groups') {
    return encodeConsumeGroupsCall(operation.groups, policy)
  }
  if (operation.type === 'cancel-root') {
    return {
      to: policy.ratifier,
      data: encodeFunctionData({
        abi: ecrecoverRatifierAbi,
        functionName: 'cancelRoot',
        args: [policy.maker, operation.root]
      })
    }
  }
  // The remaining member is unratify-root; the parameter type rejects anything else.
  return {
    to: policy.ratifier,
    data: encodeFunctionData({
      abi: setterRatifierAbi,
      functionName: 'setIsRootRatified',
      args: [policy.maker, operation.root, false]
    })
  }
}

/**
 * Encodes the Setter root-approval call for one middleware-derived root:
 * `setIsRootRatified(maker, root, true)` on the pinned Setter ratifier — the only transaction a
 * ratify intent ever signs, and only for a root the middleware recomputed itself.
 * @param root - Offer-tree root re-derived by the middleware from the validated offer set.
 * @param policy - Parsed deployment policy supplying the maker and ratifier pins.
 * @returns The encoded zero-value ratification call.
 */
export const encodeRatifyRootCall = (
  root: Hex,
  policy: QuoterSignerPolicy
): EncodedContractCall => ({
  to: policy.ratifier,
  data: encodeFunctionData({
    abi: setterRatifierAbi,
    functionName: 'setIsRootRatified',
    args: [policy.maker, root, true]
  })
})
