import type { Tree } from '@morpho-org/midnight-sdk'
import type { Address, Chain, Hex, LocalAccount, TypedDataDefinition } from 'viem'

import { EcrecoverRatifierUtils } from '@morpho-org/midnight-sdk'
import { createWalletClient, custom, hashTypedData, isAddress, isAddressEqual } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type CreateBootstrapRequirementClientParameters = {
  account: LocalAccount
  chain: Chain
  tree: Tree
}

type BootstrapRequirementClient = {
  account: { address: Address }
  chain: { id: number }
  signTypedData: (parameters: TypedDataDefinition) => Promise<Hex>
  signMessage: (parameters: { message: string }) => Promise<Hex>
}

/**
 * Creates a wallet-shaped client that can sign only one exact bootstrap offer-tree payload.
 * @param parameters - Local maker account, target chain, and canonical bootstrap tree.
 * @returns A JSON-RPC-account wallet client whose transport permits only the expected typed data.
 * @throws `BootstrapAdapterError` when a caller requests another method, account, or payload.
 * @remarks The returned client never exposes the local account. Its transport rejects every RPC
 * method except the exact `eth_signTypedData_v4` request and signs that payload locally.
 */
export const createBootstrapRequirementClient = (
  parameters: CreateBootstrapRequirementClientParameters
): BootstrapRequirementClient => {
  const sdkTypedData = EcrecoverRatifierUtils.typedData({
    tree: parameters.tree,
    chainId: parameters.chain.id
  })
  const typedData = sdkTypedData as unknown as TypedDataDefinition
  const expectedHash = hashTypedData(typedData)
  const request = async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    try {
      if (method !== 'eth_signTypedData_v4' || params?.length !== 2) {
        throw new BootstrapAdapterError('requirement-signing-policy')
      }
      const [requestedAccount, serializedTypedData] = params
      if (
        typeof requestedAccount !== 'string' ||
        typeof serializedTypedData !== 'string' ||
        !isAddress(requestedAccount)
      ) {
        throw new BootstrapAdapterError('requirement-signing-policy')
      }
      if (!isAddressEqual(requestedAccount, parameters.account.address)) {
        throw new BootstrapAdapterError('requirement-signing-policy')
      }
      const requestedHash = hashTypedData(JSON.parse(serializedTypedData))
      if (requestedHash !== expectedHash) {
        throw new BootstrapAdapterError('requirement-signing-policy')
      }
      return parameters.account.signTypedData(typedData)
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('requirement-signing-policy')
    }
  }

  return createWalletClient({
    account: parameters.account.address,
    chain: parameters.chain,
    transport: custom({ request })
  }) as unknown as BootstrapRequirementClient
}
