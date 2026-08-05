import type { MidnightOfferRootSignature } from '@morpho-org/morpho-sdk'
import type { Address, Hex } from 'viem'

import { isAddressEqual } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { assertBootstrapTransaction } from './bootstrap-transaction.utils'

type RootSignatureRequirement = {
  action: {
    type: 'midnightOfferRootSignature'
    args: { root: Hex; ratifier: Address; offers: number }
  }
  sign: (...parameters: unknown[]) => unknown
}

type SetterRootRequirement = {
  to: Address
  data: Hex
  value: bigint
  action: {
    type: 'setterRatifierRatifyRoot'
    args: { maker: Address; root: Hex; isRootRatified: boolean }
  }
}

type BootstrapRequirementPolicy =
  | { kind: 'ecrecover'; target: Address; root: Hex; account: Address; offers: number }
  | { kind: 'setter'; target: Address; root: Hex; account: Address }

/**
 * Collects only supported Midnight offer-root signature and Setter approval requirements.
 * @param requirements - Untrusted runtime requirements returned by the SDK flow.
 * @param sign - Bound signer for one validated Ecrecover offer-root requirement and maker.
 * @param policy - Exact ratifier kind, target, maker, output root, and Ecrecover offer count.
 * @returns Signed Ecrecover roots and validated-shape Setter transactions for policy checking.
 * @throws `BootstrapAdapterError` for every unknown, malformed, mixed, repeated, or missing requirement set.
 * @remarks The complete set and exact action metadata are validated before `sign` is called, so
 * rejected sets have no signing or transaction side effects.
 */
export const prepareBootstrapRequirements = async (
  requirements: readonly unknown[],
  sign: (
    requirement: RootSignatureRequirement,
    account: Address
  ) => Promise<MidnightOfferRootSignature>,
  policy: BootstrapRequirementPolicy
) => {
  const signatureRequirements: RootSignatureRequirement[] = []
  const transactions: SetterRootRequirement[] = []
  for (const requirement of requirements) {
    const candidate = requirement as {
      action?: { type?: unknown; args?: unknown }
      sign?: unknown
      to?: unknown
      data?: unknown
      value?: unknown
    } | null
    if (typeof candidate !== 'object' || candidate === null || !candidate.action) {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
    if (candidate.action.type === 'midnightOfferRootSignature') {
      if (typeof candidate.sign !== 'function') {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      signatureRequirements.push(candidate as unknown as RootSignatureRequirement)
      continue
    }
    if (
      candidate.action.type !== 'setterRatifierRatifyRoot' ||
      typeof candidate.to !== 'string' ||
      typeof candidate.data !== 'string' ||
      typeof candidate.value !== 'bigint' ||
      typeof candidate.action.args !== 'object' ||
      candidate.action.args === null
    ) {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
    transactions.push(candidate as unknown as SetterRootRequirement)
  }
  const invalidCardinality =
    policy.kind === 'setter'
      ? transactions.length !== 1 || signatureRequirements.length > 0
      : signatureRequirements.length !== 1 || transactions.length > 0
  if (invalidCardinality) {
    throw new BootstrapAdapterError('unexpected-requirement')
  }
  if (policy.kind === 'setter') {
    const transaction = transactions[0]!
    const args = transaction.action.args
    try {
      if (
        !isAddressEqual(args.maker, policy.account) ||
        args.root !== policy.root ||
        !args.isRootRatified
      ) {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      await assertBootstrapTransaction(transaction, {
        kind: 'ratification',
        target: policy.target,
        root: policy.root,
        account: policy.account
      })
    } catch {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
    return { signatures: [], transactions }
  }
  const requirement = signatureRequirements[0]!
  const args = requirement.action.args
  try {
    if (
      typeof args !== 'object' ||
      args === null ||
      args.root !== policy.root ||
      typeof args.ratifier !== 'string' ||
      !isAddressEqual(args.ratifier, policy.target) ||
      args.offers !== policy.offers
    ) {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
  } catch {
    throw new BootstrapAdapterError('unexpected-requirement')
  }
  const signature = await sign(requirement, policy.account)
  return { signatures: [signature], transactions: [] }
}
