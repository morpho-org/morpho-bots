import { SignerPolicyError, SignerResponseError } from '@repo/signer-client'

export function isSignerError(error: unknown): error is SignerPolicyError | SignerResponseError {
  return error instanceof SignerPolicyError || error instanceof SignerResponseError
}
