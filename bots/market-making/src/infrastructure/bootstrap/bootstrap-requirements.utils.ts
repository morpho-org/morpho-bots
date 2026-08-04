import type { MidnightOfferRootSignature } from '@morpho-org/morpho-sdk'
import type { Address, Hex } from 'viem'

import { isAddressEqual } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { assertBootstrapTransaction } from './bootstrap-transaction.utils'

type RootSignatureRequirement = {
  action: { type: 'midnightOfferRootSignature' }
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

/**
 * Collects only supported Midnight offer-root signature and Setter approval requirements.
 * @param requirements - Untrusted runtime requirements returned by the SDK flow.
 * @param sign - Bound signer for one validated Ecrecover offer-root requirement.
 * @param ratifierType - Runtime-selected ratifier kind whose exact requirement set is required.
 * @param setterPolicy - Exact configured Setter target, maker, and output root when Setter is selected.
 * @returns Signed Ecrecover roots and validated-shape Setter transactions for policy checking.
 * @throws `BootstrapAdapterError` for every unknown, malformed, mixed, repeated, or missing requirement set.
 * @remarks The complete set is validated before `sign` is called, so rejected sets have no signing
 * or transaction side effects.
 */
export const prepareBootstrapRequirements = async (
  requirements: readonly unknown[],
  sign: (requirement: RootSignatureRequirement) => Promise<MidnightOfferRootSignature>,
  ratifierType: 'ecrecover' | 'setter',
  setterPolicy?: { target: Address; root: Hex; account: Address }
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
    ratifierType === 'setter'
      ? transactions.length !== 1 || signatureRequirements.length > 0
      : signatureRequirements.length !== 1 || transactions.length > 0
  if (invalidCardinality) {
    throw new BootstrapAdapterError('unexpected-requirement')
  }
  if (ratifierType === 'setter') {
    const transaction = transactions[0]!
    const args = transaction.action.args
    try {
      if (
        setterPolicy === undefined ||
        !isAddressEqual(args.maker, setterPolicy.account) ||
        args.root !== setterPolicy.root ||
        !args.isRootRatified
      ) {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      await assertBootstrapTransaction(transaction, {
        kind: 'ratification',
        ...setterPolicy
      })
    } catch {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
  }
  const signatures = await Promise.all(signatureRequirements.map(sign))
  return { signatures, transactions }
}
