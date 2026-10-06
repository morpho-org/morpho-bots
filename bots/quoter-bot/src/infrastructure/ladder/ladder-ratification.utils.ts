import type { Address, LocalAccount } from 'viem'

import {
  EcrecoverRatifierUtils,
  SetterRatifierUtils,
  setterRatifierAbi,
  type Tree
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { encodeFunctionData, isAddressEqual } from 'viem'

import type { SupportedChainId } from '../../config/supported-chains.utils'

import { LadderAdapterError } from './ladder-adapter.error'
import { signLadderTree } from './ladder-signature.utils'

type EcrecoverSignParameters = Parameters<typeof EcrecoverRatifierUtils.sign>[0]
type RatifierType = 'ecrecover' | 'setter'

type PrepareLadderRatificationParameters = {
  type: RatifierType
  tree: Tree
  maker: Address
  client: EcrecoverSignParameters['client']
  account: LocalAccount
}

/**
 * Classifies a configured canonical ratifier address for one chain.
 * @param ratifier - Canonical SDK ratifier configured on every generated offer.
 * @param chainId - Configured chain whose canonical ratifier addresses are compared.
 * @returns The ratifier kind selected by that chain's canonical deployment address.
 * @throws `LadderAdapterError` when the address is not a canonical ratifier on the given chain.
 * @remarks Ratifier addresses differ per chain, so a ratifier canonical on another chain is
 * rejected here rather than silently accepted.
 */
export const configuredRatifierType = (
  ratifier: Address,
  chainId: SupportedChainId
): RatifierType => {
  if (isAddressEqual(ratifier, getChainAddress(chainId, 'setterRatifier'))) return 'setter'
  if (isAddressEqual(ratifier, getChainAddress(chainId, 'ecrecoverRatifier'))) return 'ecrecover'
  throw new LadderAdapterError('unsupported-ratifier')
}

/**
 * Prepares the Router-compatible ratifier payload and any prerequisite root-approval transaction.
 * @param parameters - Canonical tree, maker, selected ratifier kind, signer account, and wallet client.
 * @returns Payload items, plus a Setter approval transaction and its final mempool validation input.
 * @throws `LadderAdapterError` when Ecrecover signing fails; SDK tree validation errors pass through.
 * @remarks Performs no network I/O. Setter callers must confirm `approval` before final mempool
 * validation and publication. An Ecrecover signature is a replayable authorization anyone can
 * publish, so it carries no validation input: validate the unsigned tree before signing instead.
 */
export const prepareLadderRatification = async (
  parameters: PrepareLadderRatificationParameters
) => {
  if (parameters.type === 'setter') {
    const items = SetterRatifierUtils.ratify({ tree: parameters.tree })
    return {
      items,
      validation: { type: 'setter' as const },
      approval: {
        to: items[0]!.offer.ratifier,
        data: encodeFunctionData({
          abi: setterRatifierAbi,
          functionName: 'setIsRootRatified',
          args: [parameters.maker, parameters.tree.root, true]
        }),
        value: 0n
      }
    }
  }

  const signature = await signLadderTree(parameters)
  return {
    items: await EcrecoverRatifierUtils.ratify({
      tree: parameters.tree,
      account: parameters.account.address,
      signature
    }),
    approval: undefined
  }
}
