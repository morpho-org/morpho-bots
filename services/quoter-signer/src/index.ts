import type { QuoterSignerResponse } from './intent.utils'

import { buildNotImplementedDenial, classifyIntentKind } from './intent.utils'
import { emitJsonLine } from './log.utils'

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
 * AWS Lambda entrypoint for the quoter-signer image (TIB-2026-08-12 delivery skeleton).
 *
 * Fail-closed by construction: no signing surface is implemented, the execution role needs no KMS
 * access, and every invocation — whatever its payload — is denied with a typed
 * `SigningNotImplementedError` envelope. Each invocation emits the TIB's
 * `middleware.intent_received` and `middleware.intent_denied` JSON log lines to stdout
 * (CloudWatch Logs); only allowlisted intent kinds and middleware-owned values are logged, never
 * caller-supplied data. The handler never throws on any payload shape.
 * @param event - Raw, untrusted invocation payload; inspected only to classify the intent kind.
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
  const response = buildNotImplementedDenial()
  emitJsonLine({
    event: 'middleware.intent_denied',
    intentKind,
    awsRequestId,
    denial: response.denial.name
  })
  return response
}
