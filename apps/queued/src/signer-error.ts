import { SignerPolicyError, SignerResponseError } from '@repo/signer-client'

type SignerError = SignerPolicyError | SignerResponseError

export function isSignerError(error: unknown): error is SignerError {
  return error instanceof SignerPolicyError || error instanceof SignerResponseError
}

// A first submit lets the signer claim the nonce internally, so the queue does not know it when the
// signer rejects. The sender annotates the prepared nonce onto the (queue-local) signer error here
// so a `tx.signer_failed` log can join the signer's own nonce-keyed `signer.rejected` line. Kept in
// this app — @repo/signer-client has no nonce concept and its wire protocol is unchanged.
type WithQueuedNonce = { queuedNonce?: number }

export function attachSignerNonce(error: SignerError, nonce: number): void {
  ;(error as SignerError & WithQueuedNonce).queuedNonce = nonce
}

export function signerErrorNonce(error: SignerError): number | undefined {
  return (error as SignerError & WithQueuedNonce).queuedNonce
}
