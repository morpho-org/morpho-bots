import type { Hex, TransactionSerializableEIP1559 } from 'viem'

import { keccak256, parseSignature, serializeTransaction } from 'viem'

import type { IntentFees } from './intent.utils'
import type { KmsSignedDigest } from './kms-signer.utils'
import type { SignedTransactionArtifact } from './response.utils'
import type { EncodedContractCall } from './transaction-encode.utils'

import { ArtifactEncodingFailedError } from './artifact-encoding-failed.error'

/**
 * The fields of one maker transaction the middleware is about to sign. Everything here is
 * middleware-owned by construction: the chain id is the policy pin, the nonce is the independent
 * pending-nonce read, the call was canonically encoded from the validated intent, the value is
 * always zero, and only the fee fields originate from the caller — as ceiling-checked liveness
 * parameters (TIB-2026-08-12).
 */
export type MakerTransactionRequest = {
  /** Policy-pinned EIP-155 chain id the signature commits to. */
  readonly chainId: number
  /** Independently read pending nonce the signature commits to. */
  readonly nonce: number
  /** Canonically encoded target and calldata. */
  readonly call: EncodedContractCall
  /** Ceiling-checked caller-supplied EIP-1559 liveness parameters. */
  readonly fees: IntentFees
}

/**
 * A maker transaction ready for canonical serialization: viem's EIP-1559 serializable shape with
 * the nonce required rather than optional, because every middleware transaction commits to the
 * independently read pending nonce.
 */
export type MakerTransaction = TransactionSerializableEIP1559 & { readonly nonce: number }

/**
 * Builds the canonical EIP-1559 serializable transaction for one request. The `type` is pinned
 * explicitly so a malformed request can never silently serialize as a different transaction
 * envelope with a different digest, and the value is the literal zero every TIB-2026-08-12
 * transaction intent requires.
 * @param request - Validated maker transaction fields.
 * @returns The viem-serializable zero-value EIP-1559 transaction.
 */
export const buildMakerTransaction = (request: MakerTransactionRequest): MakerTransaction => ({
  type: 'eip1559',
  chainId: request.chainId,
  nonce: request.nonce,
  to: request.call.to,
  value: 0n,
  data: request.call.data,
  gas: BigInt(request.fees.gas),
  maxFeePerGas: BigInt(request.fees.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(request.fees.maxPriorityFeePerGas)
})

/**
 * Derives the 32-byte signing digest of one unsigned maker transaction — the keccak-256 hash of
 * its canonical serialization, exactly what viem's own account signing flow hashes. This is the
 * only transaction digest ever handed to `kms:Sign` for the request.
 * @param transaction - Transaction built by {@link buildMakerTransaction}.
 * @returns The unsigned-transaction digest.
 */
export const deriveMakerTransactionDigest = (transaction: MakerTransaction): Hex =>
  keccak256(serializeTransaction(transaction))

/**
 * Assembles the broadcastable signed-transaction artifact from the KMS signature over the
 * transaction's digest. The signature already passed the strict DER/low-s/recovery discipline of
 * the KMS signer, so its recovery parity is trustworthy; the artifact's hash is the keccak-256 of
 * the signed serialization — what nodes will report for the broadcast.
 * @param transaction - The exact unsigned transaction whose digest was signed.
 * @param fees - Ceiling-checked fee fields the signature commits to, echoed into the artifact.
 * @param signed - Verified KMS signature over {@link deriveMakerTransactionDigest}'s output.
 * @returns The complete {@link SignedTransactionArtifact} for the response envelope.
 * @throws `ArtifactEncodingFailedError` with stage `transaction` on any serialization fault —
 * a post-sign middleware bug; the caller has already recorded the KMS call.
 */
export const assembleSignedTransaction = (
  transaction: MakerTransaction,
  fees: IntentFees,
  signed: KmsSignedDigest
): SignedTransactionArtifact => {
  try {
    const signedTransaction = serializeTransaction(transaction, parseSignature(signed.signature))
    return {
      signedTransaction,
      hash: keccak256(signedTransaction),
      nonce: transaction.nonce,
      fees
    }
  } catch (error) {
    throw new ArtifactEncodingFailedError('transaction', { cause: error })
  }
}
