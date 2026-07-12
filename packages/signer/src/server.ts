import type { LocalAccount } from 'viem'

import { createUnixJsonServer } from '@repo/bot-kit'
import { keccak256 } from 'viem'

import type { Policy } from './policy'

import { evaluatePolicy } from './policy'
import {
  errorResponse,
  fromWireTx,
  okResponse,
  parseRequestLine,
  ProtocolError,
  serializeResponse,
  toWireTx
} from './protocol'

export const MAX_LINE_BYTES = 65_536

type SignerLog = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export type SignerServer = {
  listen(): Promise<void>
  close(): Promise<void>
  address: string
}

/** Default-deny signing protocol over the shared private Unix JSON transport. */
export function createSignerServer(options: {
  socketPath: string
  account: LocalAccount
  policy: Policy
  log: SignerLog
}): SignerServer {
  const { socketPath, account, policy, log } = options

  async function handleLine(line: string): Promise<string> {
    try {
      const request = parseRequestLine(line)
      switch (request.method) {
        case 'address':
          return serializeResponse(okResponse({ address: account.address }))
        case 'signTransaction': {
          const wire = toWireTx(request.transaction)
          const decision = evaluatePolicy(policy, wire)
          if (!decision.ok) {
            log.warn('signer.rejected', {
              check: decision.check,
              chainId: wire.chainId,
              to: wire.to
            })
            return serializeResponse(
              errorResponse('policy_violation', decision.message, {
                check: decision.check
              })
            )
          }
          const signedTransaction = await account.signTransaction(fromWireTx(wire))
          log.info('signer.signed', {
            chainId: wire.chainId,
            to: wire.to,
            nonce: wire.nonce,
            gas: wire.gas,
            maxFeePerGas: wire.maxFeePerGas,
            hash: keccak256(signedTransaction)
          })
          return serializeResponse(okResponse({ signedTransaction }))
        }
      }
      throw new ProtocolError('bad_request', 'unsupported signer method')
    } catch (error) {
      if (error instanceof ProtocolError) {
        return serializeResponse(errorResponse(error.code, error.message))
      }
      log.error('signer.internal', {
        error: error instanceof Error ? error.message : String(error)
      })
      return serializeResponse(errorResponse('internal', 'internal signer error'))
    }
  }

  const server = createUnixJsonServer({
    socketPath,
    maxLineBytes: MAX_LINE_BYTES,
    handleLine,
    oversizeResponse: () =>
      serializeResponse(errorResponse('bad_request', 'request line too large'))
  })
  return { ...server, address: account.address }
}
