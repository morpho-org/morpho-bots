import type { LocalAccount, TransactionSerializable } from 'viem'

import { connect } from 'node:net'
import { getAddress, isAddress, isHex } from 'viem'
import { toAccount } from 'viem/accounts'

import type { SignerErrorBody, SignerRequest, SignerResponse, WireTx } from './protocol'

import { SIGNER_PROTOCOL_VERSION } from './protocol'

/** Thrown when the agent rejects a tx on policy grounds — distinguishable from an on-chain revert. */
export class AgentPolicyError extends Error {
  readonly code = 'policy_violation'
  readonly rule: string | undefined
  readonly check: string | undefined

  constructor(message: string, rule?: string, check?: string) {
    super(message)
    this.name = 'AgentPolicyError'
    this.rule = rule
    this.check = check
  }
}

/** Thrown for any non-policy error response from the agent (bad request, unsupported version, internal). */
export class AgentResponseError extends Error {
  readonly code: SignerErrorBody['code']

  constructor(body: SignerErrorBody) {
    super(body.message)
    this.name = 'AgentResponseError'
    this.code = body.code
  }
}

const ERROR_CODES: readonly SignerErrorBody['code'][] = [
  'bad_request',
  'unsupported_version',
  'policy_violation',
  'internal'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Validated narrow of a socket line into the response envelope: the version we speak, exactly one
// of result/error, and a well-formed error body. Deeper result shapes are checked at the use site.
function isSignerResponse(value: unknown): value is SignerResponse {
  if (!isRecord(value) || value.v !== SIGNER_PROTOCOL_VERSION) return false
  if ('error' in value) {
    if ('result' in value) return false
    const { error } = value
    return (
      isRecord(error) &&
      typeof error.message === 'string' &&
      ERROR_CODES.some(code => code === error.code)
    )
  }
  return isRecord(value.result)
}

/**
 * Sends one request over a fresh short-lived connection and resolves the single response line. One
 * connection per request keeps the client correct across daemon restarts with no reconnect logic;
 * Unix-socket latency is negligible at queue cadence. Connect/timeout failures throw plain errors
 * (transient); the caller distinguishes those from typed protocol errors.
 */
export function requestOnce(
  socketPath: string,
  request: SignerRequest,
  timeoutMs = 5_000
): Promise<SignerResponse> {
  return new Promise<SignerResponse>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    let settled = false

    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      action()
    }

    const timer = setTimeout(
      () => finish(() => reject(new Error(`signer request timed out after ${timeoutMs}ms`))),
      timeoutMs
    )

    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      const line = buffer.slice(0, idx)
      finish(() => {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          reject(new Error('signer returned a non-JSON response line'))
          return
        }
        if (!isSignerResponse(parsed)) {
          reject(new Error('malformed signer response envelope'))
          return
        }
        resolve(parsed)
      })
    })
    socket.on('error', error => finish(() => reject(error)))
    socket.on('close', () =>
      finish(() => reject(new Error('signer connection closed before a response')))
    )
  })
}

function unwrapResult(response: SignerResponse): unknown {
  if ('error' in response) {
    const { error } = response
    if (error.code === 'policy_violation') {
      throw new AgentPolicyError(error.message, error.rule, error.check)
    }
    throw new AgentResponseError(error)
  }
  return response.result
}

// Whitelist-extract exactly the signing fields viem hands us; never forward the prepared blob.
// `value` defaults to 0n; every other field is mandatory (a missing field is a caller bug, not a
// policy matter, so we throw a clear error rather than sending a malformed request).
function toWireTxRequest(transaction: TransactionSerializable): WireTx {
  const maxFeePerGas = 'maxFeePerGas' in transaction ? transaction.maxFeePerGas : undefined
  const maxPriorityFeePerGas =
    'maxPriorityFeePerGas' in transaction ? transaction.maxPriorityFeePerGas : undefined
  const { chainId, to, data, value, nonce, gas } = transaction

  if (
    chainId === undefined ||
    to === undefined ||
    to === null ||
    data === undefined ||
    nonce === undefined ||
    gas === undefined ||
    maxFeePerGas === undefined ||
    maxPriorityFeePerGas === undefined
  ) {
    const missing: string[] = []
    if (chainId === undefined) missing.push('chainId')
    if (to === undefined || to === null) missing.push('to')
    if (data === undefined) missing.push('data')
    if (nonce === undefined) missing.push('nonce')
    if (gas === undefined) missing.push('gas')
    if (maxFeePerGas === undefined) missing.push('maxFeePerGas')
    if (maxPriorityFeePerGas === undefined) missing.push('maxPriorityFeePerGas')
    throw new Error(`agent signer: prepared tx missing required field(s): ${missing.join(', ')}`)
  }

  return {
    type: 'eip1559',
    chainId,
    to: getAddress(to),
    data,
    value: (value ?? 0n).toString(),
    nonce,
    gas: gas.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString()
  }
}

/**
 * Builds a keyless viem `LocalAccount` backed by the signing agent. Fetches the agent's address
 * (the startup handshake), then returns an account whose `signTransaction` round-trips through the
 * socket. `signMessage`/`signTypedData` are unsupported stubs. Policy rejections surface as
 * {@link AgentPolicyError}; transient connect failures propagate as plain errors.
 */
export async function createAgentAccount(options: { socketPath: string }): Promise<LocalAccount> {
  const { socketPath } = options
  const handshake = await requestOnce(socketPath, {
    v: SIGNER_PROTOCOL_VERSION,
    id: 'handshake',
    method: 'address'
  })
  const result = unwrapResult(handshake)
  const address =
    typeof result === 'object' && result !== null
      ? (result as { address?: unknown }).address
      : undefined
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    throw new Error('signer handshake did not return a valid address')
  }

  return toAccount({
    address: getAddress(address),
    async signTransaction(transaction) {
      const params = toWireTxRequest(transaction)
      const response = await requestOnce(socketPath, {
        v: SIGNER_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        method: 'signTransaction',
        params
      })
      const signed = unwrapResult(response)
      const signedTransaction =
        typeof signed === 'object' && signed !== null
          ? (signed as { signedTransaction?: unknown }).signedTransaction
          : undefined
      if (!isHex(signedTransaction)) {
        throw new Error('signer did not return a signed transaction')
      }
      return signedTransaction
    },
    signMessage() {
      return Promise.reject(new Error('agent account does not support signMessage'))
    },
    signTypedData() {
      return Promise.reject(new Error('agent account does not support signTypedData'))
    }
  })
}
