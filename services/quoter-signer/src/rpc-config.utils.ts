import { RpcNotConfiguredError } from './rpc-not-configured.error'

/**
 * Deployment parameter carrying the RPC endpoint URL for the middleware's own chain reads
 * (TIB-2026-08-12: the maker's pending nonce is read independently, never caller-supplied). Like
 * every policy-relevant input, it lives in the middleware's deployment, not in the request.
 */
export const QUOTER_SIGNER_RPC_URL_VARIABLE = 'QUOTER_SIGNER_RPC_URL'

/** Validated RPC endpoint addressing for the middleware's independent chain reads. */
export type RpcConfig = {
  /** HTTP(S) JSON-RPC endpoint URL. Never logged and never echoed in errors or responses. */
  readonly url: string
}

/**
 * Strictly parses the `QUOTER_SIGNER_RPC_URL` deployment parameter.
 *
 * Transaction-signing intents (ratify, revoke, setup remediation) fail closed without a usable
 * endpoint because the pending-nonce read cannot happen; quote intents sign no maker transaction
 * and never require it.
 * @param source - Raw `QUOTER_SIGNER_RPC_URL` environment value, or `undefined` when unset.
 * @returns The validated {@link RpcConfig}.
 * @throws `RpcNotConfiguredError` when the value is missing, not a URL, or not `http(s)`.
 */
export const parseRpcConfig = (source: string | undefined): RpcConfig => {
  if (source === undefined || source.trim() === '') {
    throw new RpcNotConfiguredError(QUOTER_SIGNER_RPC_URL_VARIABLE, 'missing')
  }
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new RpcNotConfiguredError(QUOTER_SIGNER_RPC_URL_VARIABLE, 'invalid-url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RpcNotConfiguredError(QUOTER_SIGNER_RPC_URL_VARIABLE, 'invalid-url')
  }
  return { url: source }
}
