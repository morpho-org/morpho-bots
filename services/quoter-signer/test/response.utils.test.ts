import { describe, expect, it } from 'vitest'

import type {
  EncodedPublication,
  QuoteApproval,
  QuoterSignerApprovalResponse,
  QuoterSignerApprovalResult,
  QuoterSignerDenial,
  QuoterSignerDenialResponse,
  QuoterSignerResponse,
  RatifyApproval,
  RevokeApproval,
  SetupRemediationApproval,
  SignedTransactionArtifact
} from '../src/response.utils'

import { MalformedIntentError } from '../src/malformed-intent.error'
import { buildDenialResponse } from '../src/response.utils'
import { SigningNotImplementedError } from '../src/signing-not-implemented.error'

const publication: EncodedPublication = {
  to: '0x2222222222222222222222222222222222222222',
  data: '0xdeadbeef',
  value: '0'
}

const transaction: SignedTransactionArtifact = {
  signedTransaction: '0x02f870',
  hash: `0x${'aa'.repeat(32)}`,
  nonce: 7,
  fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', gas: '90000' }
}

describe('quoter-signer response contract', () => {
  it('models every per-kind approval payload as one discriminated union', () => {
    const quote: QuoteApproval = {
      kind: 'quote',
      root: `0x${'11'.repeat(32)}`,
      treeSignature: `0x${'22'.repeat(65)}`,
      publication
    }
    const ratify: RatifyApproval = {
      kind: 'ratify',
      root: `0x${'11'.repeat(32)}`,
      transaction,
      publication
    }
    const revoke: RevokeApproval = { kind: 'revoke', transaction }
    const remediation: SetupRemediationApproval = { kind: 'setup-remediation', transaction }
    const results: readonly QuoterSignerApprovalResult[] = [quote, ratify, revoke, remediation]

    expect(results.map(result => result.kind)).toStrictEqual([
      'quote',
      'ratify',
      'revoke',
      'setup-remediation'
    ])
  })

  it('narrows the response union by the approved discriminator', () => {
    const approval: QuoterSignerApprovalResponse = {
      contractVersion: 1,
      service: 'quoter-signer',
      approved: true,
      result: { kind: 'revoke', transaction }
    }
    const responses: readonly QuoterSignerResponse[] = [
      approval,
      buildDenialResponse(new SigningNotImplementedError('break-glass-revoke'))
    ]

    expect(
      responses.map(response => (response.approved ? response.result.kind : response.denial.name))
    ).toStrictEqual(['revoke', 'SigningNotImplementedError'])
  })

  it.each<[QuoterSignerDenial['name'], () => QuoterSignerDenial & Error]>([
    ['SigningNotImplementedError', () => new SigningNotImplementedError('self-cancel')],
    ['MalformedIntentError', () => new MalformedIntentError('offers[0].maxAssets', 'out-of-range')]
  ])('maps a %s cause into the versioned denial envelope', (name, cause) => {
    const error = cause()

    const response: QuoterSignerDenialResponse = buildDenialResponse(error)

    expect(response).toStrictEqual({
      contractVersion: 1,
      service: 'quoter-signer',
      approved: false,
      denial: { name, message: error.message, retryable: false }
    })
  })
})
