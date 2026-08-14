import { midnightAbi } from '@morpho-org/midnight-sdk'
import {
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  maxUint256,
  pad,
  parseAbiParameters,
  toHex,
  createWalletClient
} from 'viem'
import { base } from 'viem/chains'

import type { AnvilHandle } from './anvil'

import {
  ANVIL_DEFAULT_ACCOUNT,
  ECRECOVER_RATIFIER,
  MAKER_USDC_BALANCE,
  MIDNIGHT,
  USDC
} from './constants'

// Circle's Base FiatToken proxy stores its balances mapping at slot 9. The balance read-back returned
// by setupMaker catches any storage-layout drift at the pinned fork.
const USDC_BALANCE_STORAGE_SLOT = 9n

const tokenBalanceStorageKey = () =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256'), [
      ANVIL_DEFAULT_ACCOUNT.address,
      USDC_BALANCE_STORAGE_SLOT
    ])
  )

/**
 * Funds and authorizes Anvil's default account as the quoter.
 *
 * @param anvil - Running pinned Base fork.
 * @returns The seeded USDC balance and receipts for the approval and ratifier authorization.
 * @throws When the storage override, simulation, transaction submission, or receipt read fails.
 * @remarks Writes only to the disposable Anvil fork. USDC is seeded with `setStorageAt`; approval
 * and Midnight authorization use real contract transactions from Anvil account zero.
 */
export const setupMaker = async (anvil: AnvilHandle) => {
  const wallet = createWalletClient({
    account: ANVIL_DEFAULT_ACCOUNT,
    chain: base,
    transport: http(anvil.rpcUrl)
  })

  await anvil.client.setStorageAt({
    address: USDC,
    index: tokenBalanceStorageKey(),
    value: pad(toHex(MAKER_USDC_BALANCE), { size: 32 })
  })
  const balance = await anvil.client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ANVIL_DEFAULT_ACCOUNT.address]
  })

  const { request: approvalRequest } = await anvil.client.simulateContract({
    account: ANVIL_DEFAULT_ACCOUNT,
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [MIDNIGHT, maxUint256]
  })
  const approvalHash = await wallet.writeContract(approvalRequest)
  const approvalReceipt = await anvil.client.waitForTransactionReceipt({ hash: approvalHash })

  const { request: authorizationRequest } = await anvil.client.simulateContract({
    account: ANVIL_DEFAULT_ACCOUNT,
    address: MIDNIGHT,
    abi: midnightAbi,
    functionName: 'setIsAuthorized',
    args: [ECRECOVER_RATIFIER, true, ANVIL_DEFAULT_ACCOUNT.address]
  })
  const authorizationHash = await wallet.writeContract(authorizationRequest)
  const authorizationReceipt = await anvil.client.waitForTransactionReceipt({
    hash: authorizationHash
  })

  return { balance, receipts: [approvalReceipt, authorizationReceipt] }
}
