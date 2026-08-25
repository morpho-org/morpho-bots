import type { QuoterSignerResponse } from './response.utils'

import { classifyIntentKind, parseQuoterSignerIntent } from './intent.utils'
import { emitJsonLine } from './log.utils'
import { MalformedIntentError } from './malformed-intent.error'
import { buildDenialResponse } from './response.utils'
import { SigningNotImplementedError } from './signing-not-implemented.error'

/**
 * Structural slice of the AWS Lambda context consumed by the handler. A local structural type
 * keeps the skeleton dependency-free; the full `@types/aws-lambda` surface is not needed for one
 * optional field.
 */
export type LambdaContextLike = {
  /** AWS request id correlating the invocation with CloudWatch and CloudTrail records. */
  readonly awsRequestId?: string
}

/**
 * AWS Lambda entrypoint for the quoter-signer image (TIB-2026-08-12).
 *
 * The v1 wire contract is enforced at this boundary: the payload must parse as one versioned
 * structured intent (quote, ratify, revoke, or setup-remediation — see `intent.utils.ts`), and
 * the return value is always a versioned approval-or-denial envelope (see `response.utils.ts`).
 * This build remains fail-closed by construction: no signing surface is implemented, the
 * execution role needs no KMS access, and every invocation is denied — payloads outside the
 * contract with a typed `MalformedIntentError`, well-formed intents with a typed
 * `SigningNotImplementedError`. Each invocation emits the TIB's `middleware.intent_received` and
 * `middleware.intent_denied` JSON log lines to stdout (CloudWatch Logs); only allowlisted intent
 * kinds, denial class names, and middleware-owned values are logged, never caller-supplied data.
 * The handler never throws on any payload shape.
 * @param event - Raw, untrusted invocation payload validated against the v1 intent contract.
 * @param context - Lambda context; only `awsRequestId` is read, for log correlation.
 * @returns The versioned fail-closed denial envelope.
 */
export const handler = async (
  event: unknown,
  context?: LambdaContextLike
): Promise<QuoterSignerResponse> => {
  const awsRequestId = context?.awsRequestId
  const intentKind = classifyIntentKind(event)
  emitJsonLine({ event: 'middleware.intent_received', intentKind, awsRequestId })
  let denial: MalformedIntentError | SigningNotImplementedError
  try {
    parseQuoterSignerIntent(event)
    denial = new SigningNotImplementedError()
  } catch (error) {
    // The parser only throws MalformedIntentError; anything else still fails closed as malformed.
    denial =
      error instanceof MalformedIntentError
        ? error
        : new MalformedIntentError('intent', 'wrong-type')
  }
  const response = buildDenialResponse(denial)
  emitJsonLine({
    event: 'middleware.intent_denied',
    intentKind,
    awsRequestId,
    denial: response.denial.name
  })
  return response
}
