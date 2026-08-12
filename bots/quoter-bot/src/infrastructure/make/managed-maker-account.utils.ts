import type { Hex } from 'viem'

import { privateKeyToAccount } from 'viem/accounts'
import { createNonceManager, jsonRpc } from 'viem/nonce'

/**
 * Creates the local maker account with a pending-aware in-process nonce cursor.
 * @param privateKey - Validated maker private key retained only at the wallet boundary.
 * @returns A local account that signs without RPC custody and allocates sequential nonces safely.
 * @remarks The nonce manager initializes from `pending` chain truth and advances for each send,
 * preventing rapid publication or multi-group cleanup transactions from reusing a stale RPC nonce.
 */
export const createManagedMakerAccount = (privateKey: Hex) =>
  privateKeyToAccount(privateKey, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
