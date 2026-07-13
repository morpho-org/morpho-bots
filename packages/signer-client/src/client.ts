import type { Address, TransactionSerializableEIP1559, TransactionSerializedEIP1559 } from 'viem'

import { connect } from 'node:net'
import {
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseTransaction,
  recoverTransactionAddress
} from 'viem'

import type { SignerErrorBody, SignerRequest, SignerResponse, WireTx } from './protocol'

import { SIGNER_ERROR_CODES, SIGNER_PROTOCOL_VERSION } from './protocol'

export class SignerPolicyError extends Error {
  readonly code = 'policy_violation'

  constructor(
    message: string,
    readonly check?: string
  ) {
    super(message)
    this.name = 'SignerPolicyError'
  }
}

export class SignerResponseError extends Error {
  constructor(
    message: string,
    readonly code: SignerErrorBody['code'] = 'internal'
  ) {
    super(message)
    this.name = 'SignerResponseError'
  }
}

export type RemoteSigner = {
  address: Address
  signPreparedTransaction(
    transaction: TransactionSerializableEIP1559
  ): Promise<TransactionSerializedEIP1559>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSignerResponse(value: unknown): value is SignerResponse {
  if (!isRecord(value) || value.v !== SIGNER_PROTOCOL_VERSION || typeof value.ok !== 'boolean') {
    return false
  }
  if (value.ok) return 'result' in value && !('error' in value)
  const error = value.error
  return (
    !('result' in value) &&
    isRecord(error) &&
    typeof error.message === 'string' &&
    SIGNER_ERROR_CODES.some(code => code === error.code)
  )
}

/** One request per fresh connection: no multiplexing, correlation IDs, or reconnect state. */
function requestOnce(
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
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      finish(() => {
        let parsed: unknown
        try {
          parsed = JSON.parse(buffer.slice(0, newline))
        } catch {
          reject(new SignerResponseError('signer returned non-JSON'))
          return
        }
        if (!isSignerResponse(parsed)) {
          reject(new SignerResponseError('malformed signer response'))
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

function result(response: SignerResponse): unknown {
  if (response.ok) return response.result
  if (response.error.code === 'policy_violation') {
    throw new SignerPolicyError(response.error.message, response.error.check)
  }
  throw new SignerResponseError(response.error.message, response.error.code)
}

function toWireTx(transaction: TransactionSerializableEIP1559): WireTx {
  const { chainId, to, data, value, nonce, gas, maxFeePerGas, maxPriorityFeePerGas } = transaction
  const missing = Object.entries({
    chainId,
    to,
    data,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas
  })
    .filter(([, item]) => item === undefined || item === null)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`prepared transaction missing required field(s): ${missing.join(', ')}`)
  }
  return {
    type: 'eip1559',
    chainId,
    to: getAddress(to!),
    data: data!,
    value: (value ?? 0n).toString(),
    nonce: nonce!,
    gas: gas!.toString(),
    maxFeePerGas: maxFeePerGas!.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas!.toString()
  }
}

export async function createRemoteSigner(options: { socketPath: string }): Promise<RemoteSigner> {
  const { socketPath } = options
  const handshake = result(
    await requestOnce(socketPath, { v: SIGNER_PROTOCOL_VERSION, method: 'address' })
  )
  const address = isRecord(handshake) ? handshake.address : undefined
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    throw new SignerResponseError('signer handshake did not return a valid address')
  }
  const expectedAddress = getAddress(address)

  return {
    address: expectedAddress,
    async signPreparedTransaction(transaction) {
      const wire = toWireTx(transaction)
      const response = await requestOnce(socketPath, {
        v: SIGNER_PROTOCOL_VERSION,
        method: 'signTransaction',
        transaction: wire
      })
      const payload = result(response)
      const signed = isRecord(payload) ? payload.signedTransaction : undefined
      if (!isHex(signed) || !signed.startsWith('0x02')) {
        throw new SignerResponseError('signer did not return a serialized EIP-1559 transaction')
      }
      const serialized = signed as TransactionSerializedEIP1559
      let decoded: ReturnType<typeof parseTransaction>
      try {
        decoded = parseTransaction(serialized)
      } catch {
        throw new SignerResponseError('signer returned an invalid serialized transaction')
      }
      const matchesPrepared =
        decoded.type === 'eip1559' &&
        decoded.chainId === wire.chainId &&
        decoded.to !== null &&
        decoded.to !== undefined &&
        isAddressEqual(decoded.to, wire.to) &&
        decoded.data?.toLowerCase() === wire.data.toLowerCase() &&
        (decoded.value ?? 0n) === BigInt(wire.value) &&
        decoded.nonce === wire.nonce &&
        decoded.gas === BigInt(wire.gas) &&
        decoded.maxFeePerGas === BigInt(wire.maxFeePerGas) &&
        decoded.maxPriorityFeePerGas === BigInt(wire.maxPriorityFeePerGas)
      if (!matchesPrepared) {
        throw new SignerResponseError('signed transaction does not match prepared transaction')
      }
      let recovered: Address
      try {
        recovered = await recoverTransactionAddress({ serializedTransaction: serialized })
      } catch {
        throw new SignerResponseError('signer returned an invalid serialized transaction')
      }
      if (!isAddressEqual(recovered, expectedAddress)) {
        throw new SignerResponseError(
          `signed transaction sender ${recovered} does not match signer ${expectedAddress}`
        )
      }
      return serialized
    }
  }
}
