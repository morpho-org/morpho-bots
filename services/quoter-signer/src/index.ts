import type { QuoterSignerIntent } from './intent.utils'
import type { QuoterSignerPolicy } from './policy.utils'
import type { QuoterSignerResponse } from './response.utils'

import { IntentPolicyViolationError } from './intent-policy-violation.error'
import { classifyIntentKind, parseQuoterSignerIntent } from './intent.utils'
import { emitJsonLine } from './log.utils'
import { MalformedIntentError } from './malformed-intent.error'
import { assertIntentWithinPolicy } from './policy-check.utils'
import { PolicyNotConfiguredError } from './policy-not-configured.error'
import { parseQuoterSignerPolicy, QUOTER_SIGNER_POLICY_VARIABLE } from './policy.utils'
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

/** Every denial cause the fail-closed evaluation pipeline can produce. */
type QuoterSignerDenialCause =
  | MalformedIntentError
  | PolicyNotConfiguredError
  | IntentPolicyViolationError
  | SigningNotImplementedError

const currentUnixSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000))

/**
 * Runs the fail-closed evaluation pipeline over one untrusted invocation payload and returns the
 * denial to answer with. Stage order is the permanent contract: wire-contract parse, deployment
 * policy load, deterministic policy checks, then — until signing surfaces exist — the
 * not-implemented denial. Each stage maps unexpected faults onto its own typed denial so the
 * handler can never throw and never approves by accident.
 */
const evaluateDenial = (event: unknown): QuoterSignerDenialCause => {
  let intent: QuoterSignerIntent
  try {
    intent = parseQuoterSignerIntent(event)
  } catch (error) {
    // The parser only throws MalformedIntentError; anything else still fails closed as malformed.
    return error instanceof MalformedIntentError
      ? error
      : new MalformedIntentError('intent', 'wrong-type')
  }
  let policy: QuoterSignerPolicy
  try {
    policy = parseQuoterSignerPolicy(process.env[QUOTER_SIGNER_POLICY_VARIABLE])
  } catch (error) {
    // A policy that cannot be parsed refuses to serve; unexpected faults collapse to the same.
    return error instanceof PolicyNotConfiguredError
      ? error
      : new PolicyNotConfiguredError('policy', 'wrong-type')
  }
  try {
    assertIntentWithinPolicy(intent, policy, currentUnixSeconds())
  } catch (error) {
    // An unexpected evaluation fault is a middleware bug; it still denies, never approves.
    return error instanceof IntentPolicyViolationError
      ? error
      : new IntentPolicyViolationError('internal-fault', 'intent')
  }
  return new SigningNotImplementedError()
}

/**
 * AWS Lambda entrypoint for the quoter-signer image (TIB-2026-08-12).
 *
 * The v1 wire contract and the deterministic deployment-policy checks are enforced at this
 * boundary: the payload must parse as one versioned structured intent (quote, ratify, revoke, or
 * setup-remediation — see `intent.utils.ts`), the `QUOTER_SIGNER_POLICY` deployment parameter
 * must parse as a complete policy document (see `policy.utils.ts`), and the intent must pass
 * every check decidable from those parameters and the middleware clock (see
 * `policy-check.utils.ts`). The return value is always a versioned approval-or-denial envelope
 * (see `response.utils.ts`). This build remains fail-closed by construction: no signing surface
 * is implemented, the execution role needs no KMS access, and every invocation is denied —
 * payloads outside the contract with a typed `MalformedIntentError`, intents against a missing or
 * invalid policy with a typed `PolicyNotConfiguredError`, out-of-policy intents with a typed
 * `IntentPolicyViolationError` naming the violated check, and intents that pass every
 * deterministic check with a typed `SigningNotImplementedError`. Each invocation emits the TIB's
 * `middleware.intent_received` and `middleware.intent_denied` JSON log lines to stdout
 * (CloudWatch Logs); only allowlisted intent kinds, denial class names, check identifiers, and
 * middleware-owned values are logged, never caller-supplied data. The handler never throws on any
 * payload shape.
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
  const denial = evaluateDenial(event)
  const response = buildDenialResponse(denial)
  emitJsonLine({
    event: 'middleware.intent_denied',
    intentKind,
    awsRequestId,
    denial: response.denial.name,
    // The TIB's "violated check on denial": present only for policy violations, middleware-built.
    ...(denial instanceof IntentPolicyViolationError
      ? { check: denial.check, field: denial.field }
      : {})
  })
  return response
}
