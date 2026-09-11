import type { Address } from 'viem'

import { getChainAddress } from '@morpho-org/morpho-ts'
import { isAddressEqual } from 'viem'

import type { SupportedChainId } from './supported-chains.utils'

type WriteSignerMethod = 'private-key' | 'keystore' | 'aws'

/**
 * Determines whether the selected identity and ratifier require a Setter approval gas ceiling.
 * @param method - Configured transaction-signing backend.
 * @param ratifier - Configured canonical ratifier address.
 * @param chainId - Supported chain whose Setter deployment is authoritative.
 * @returns `true` only for local signing through that chain's canonical Setter ratifier.
 */
export const requiresMaxRatificationGas = (
  method: WriteSignerMethod,
  ratifier: Address,
  chainId: SupportedChainId
) => method !== 'aws' && isAddressEqual(ratifier, getChainAddress(chainId, 'setterRatifier'))
