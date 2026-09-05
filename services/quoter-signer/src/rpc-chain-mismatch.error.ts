/**
 * Signals that the configured RPC endpoint answered the chain-id preflight with a chain other
 * than the policy-pinned one, so every transaction-signing intent is denied before any KMS call.
 * A mismatched endpoint would make the middleware read another chain's nonce and account state
 * while signing transactions that commit to the pinned chain id — fail closed instead. Terminal
 * by classification: the endpoint or the policy pin must change through a redeploy. The message
 * is fully static; neither the endpoint URL nor the observed chain id echoes back to callers.
 */
export class RpcChainMismatchError extends Error {
  readonly name = 'RpcChainMismatchError'

  /** Terminal until the deployment is fixed: the same endpoint keeps serving the wrong chain. */
  readonly retryable = false

  /** Creates the sanitized chain-mismatch rejection. */
  constructor() {
    super('quoter-signer rpc endpoint serves a different chain than the policy pin')
  }
}
