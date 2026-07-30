import type { LocalAccount } from 'viem'

import { EcrecoverRatifierUtils } from '@morpho-org/midnight-sdk'

import { LadderAdapterError } from './ladder-adapter.error'

type EcrecoverSignParameters = Parameters<typeof EcrecoverRatifierUtils.sign>[0]

type SignLadderTreeParameters = Omit<EcrecoverSignParameters, 'account'> & {
  account: LocalAccount
}

/**
 * Signs a ladder tree with the wallet's local maker account.
 * @param parameters - Exact SDK tree, wallet client, and local private-key-backed account.
 * @returns The verified EIP-712 tree signature.
 * @throws `LadderAdapterError` when local typed-data signing or SDK verification fails.
 * @remarks Requiring `LocalAccount` prevents viem from forwarding `eth_signTypedData_v4` to the
 * configured HTTP RPC provider. The private key and returned signature are never logged.
 */
export const signLadderTree = async (parameters: SignLadderTreeParameters) => {
  try {
    return await EcrecoverRatifierUtils.sign(parameters)
  } catch {
    throw new LadderAdapterError('ratifier-signature')
  }
}
