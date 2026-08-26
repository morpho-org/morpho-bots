import type { Address } from 'viem'

import type { QuoterSignerIntent } from './intent.utils'
import type { KmsSignerConfig } from './kms-config.utils'
import type { KmsMakerSigner, KmsTransport } from './kms-signer.utils'
import type { QuoterSignerPolicy } from './policy.utils'
import type { QuoterSignerResponse } from './response.utils'

import { IntentPolicyViolationError } from './intent-policy-violation.error'
import { classifyIntentKind, parseQuoterSignerIntent } from './intent.utils'
import { KmsAttestationFailedError } from './kms-attestation-failed.error'
import {
  parseKmsSignerConfig,
  QUOTER_SIGNER_KMS_KEY_ID_VARIABLE,
  QUOTER_SIGNER_KMS_REGION_VARIABLE
} from './kms-config.utils'
import { KmsNotConfiguredError } from './kms-not-configured.error'
import {
  awsKmsTransport,
  createKmsMakerSigner,
  KMS_ATTESTATION_FRESHNESS_MS
} from './kms-signer.utils'
import { KmsUnavailableError } from './kms-unavailable.error'
import { emitJsonLine } from './log.utils'
import { MalformedIntentError } from './malformed-intent.error'
import { assertIntentWithinPolicy } from './policy-check.utils'
import { PolicyNotConfiguredError } from './policy-not-configured.error'
import { parseQuoterSignerPolicy, QUOTER_SIGNER_POLICY_VARIABLE } from './policy.utils'
import { buildDenialResponse } from './response.utils'
import { SigningNotImplementedError } from './signing-not-implemented.error'

/**
 * Structural slice of the AWS Lambda context consumed by the handler. A local structural type
 * keeps the middleware dependency-free; the full `@types/aws-lambda` surface is not needed for
 * one optional field.
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
  | KmsNotConfiguredError
  | KmsUnavailableError
  | KmsAttestationFailedError
  | SigningNotImplementedError

/** Resolves the attested maker signer for one deployment key/maker pair. */
type KmsSignerResolver = (config: KmsSignerConfig, maker: Address) => Promise<KmsMakerSigner>

const currentUnixSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000))

/**
 * Runs the fail-closed evaluation pipeline over one untrusted invocation payload and returns the
 * denial to answer with. Stage order is the permanent contract: wire-contract parse, deployment
 * policy load, deterministic policy checks, KMS maker-key custody attestation, then — until the
 * encode-and-sign surfaces exist — the not-implemented denial. Each stage maps unexpected faults
 * onto its own typed denial so the handler can never throw and never approves by accident. The
 * attestation stage runs last so caller mistakes are answered without any KMS call, and an
 * unexpected attestation fault stays retryable: KMS state was not proven either way.
 */
const evaluateDenial = async (
  event: unknown,
  resolveSigner: KmsSignerResolver
): Promise<QuoterSignerDenialCause> => {
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
  let kmsConfig: KmsSignerConfig
  try {
    kmsConfig = parseKmsSignerConfig(
      process.env[QUOTER_SIGNER_KMS_KEY_ID_VARIABLE],
      process.env[QUOTER_SIGNER_KMS_REGION_VARIABLE]
    )
  } catch (error) {
    // KMS addressing that cannot be parsed refuses to serve, like the policy document.
    return error instanceof KmsNotConfiguredError
      ? error
      : new KmsNotConfiguredError('kms', 'invalid-identifier')
  }
  try {
    await resolveSigner(kmsConfig, policy.maker)
  } catch (error) {
    if (error instanceof KmsUnavailableError || error instanceof KmsAttestationFailedError) {
      return error
    }
    // An unexpected resolution fault proved nothing about the key; fail closed but retryable.
    return new KmsUnavailableError('get-public-key', { cause: error })
  }
  return new SigningNotImplementedError()
}

/** Injectable dependencies of {@link createHandler}; production uses the AWS-backed defaults. */
export type HandlerDependencies = {
  /** KMS transport override; defaults to the `@aws-sdk/client-kms`-backed transport. */
  readonly kms?: KmsTransport
  /**
   * Whether construction starts a best-effort cold-start attestation when the deployment is fully
   * configured (default `true`). Serving never depends on the warm-up — every signing-relevant
   * invocation resolves the attestation itself — and tests that script per-invocation transport
   * behavior disable it for determinism.
   */
  readonly attestAtStartup?: boolean
}

/** The Lambda handler signature this service exports. */
export type QuoterSignerHandler = (
  event: unknown,
  context?: LambdaContextLike
) => Promise<QuoterSignerResponse>

/**
 * Builds the quoter-signer Lambda handler with its per-execution-environment signer cache.
 *
 * The attested maker signer is memoized per `(region, key id, maker)` with a
 * {@link KMS_ATTESTATION_FRESHNESS_MS} freshness bound, so one container attests once per window
 * rather than per invocation while key or deployment drift on a warm container is still caught at
 * the next window. A failed attestation is evicted from the cache before the denial is returned,
 * so a transient KMS fault never poisons the execution environment. When the deployment is fully
 * configured, construction also starts a best-effort cold-start attestation during container init
 * (a misconfigured deployment stays a typed per-invocation denial, never an init crash). The
 * factory is also the test seam for injecting a fake KMS transport.
 * @param dependencies - Optional transport and warm-up overrides; omit in production.
 * @returns The Lambda handler documented on {@link handler}.
 */
export const createHandler = (dependencies: HandlerDependencies = {}): QuoterSignerHandler => {
  const transport = dependencies.kms ?? awsKmsTransport
  const signers = new Map<string, { signer: Promise<KmsMakerSigner>; attestedAtMs: number }>()
  const resolveSigner: KmsSignerResolver = (config, maker) => {
    const key = `${config.region}\n${config.keyId}\n${maker}`
    const cached = signers.get(key)
    if (cached !== undefined && Date.now() - cached.attestedAtMs < KMS_ATTESTATION_FRESHNESS_MS) {
      return cached.signer
    }
    const entry = {
      signer: createKmsMakerSigner(config, maker, transport),
      attestedAtMs: Date.now()
    }
    signers.set(key, entry)
    // Evict only this entry on failure: a fresher attestation must never be dropped by the late
    // rejection of a stale one, while transient faults stay retryable on the next invocation.
    entry.signer.catch(() => {
      if (signers.get(key) === entry) signers.delete(key)
    })
    return entry.signer
  }
  if (dependencies.attestAtStartup !== false) {
    // Best-effort cold-start attestation: when the container's deployment parameters parse,
    // custody proving starts during init instead of waiting for the first in-policy invocation.
    try {
      const policy = parseQuoterSignerPolicy(process.env[QUOTER_SIGNER_POLICY_VARIABLE])
      const kmsConfig = parseKmsSignerConfig(
        process.env[QUOTER_SIGNER_KMS_KEY_ID_VARIABLE],
        process.env[QUOTER_SIGNER_KMS_REGION_VARIABLE]
      )
      void resolveSigner(kmsConfig, policy.maker).catch(() => {
        // The next signing-relevant invocation re-attests and reports the typed denial.
      })
    } catch {
      // Not (fully) configured: the evaluation pipeline reports the precise typed denial per
      // intent, and an init-time throw would take down even the wire-contract denials.
    }
  }
  return async (event, context) => {
    const awsRequestId = context?.awsRequestId
    const intentKind = classifyIntentKind(event)
    emitJsonLine({ event: 'middleware.intent_received', intentKind, awsRequestId })
    const denial = await evaluateDenial(event, resolveSigner)
    if (denial instanceof KmsUnavailableError || denial instanceof KmsAttestationFailedError) {
      // The TIB's dedicated KMS failure event; operation/reason are middleware-owned identifiers.
      emitJsonLine({
        event: 'middleware.kms_error',
        intentKind,
        awsRequestId,
        ...(denial instanceof KmsUnavailableError
          ? { operation: denial.operation }
          : { reason: denial.reason })
      })
    }
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
}

/**
 * AWS Lambda entrypoint for the quoter-signer image (TIB-2026-08-12).
 *
 * The v1 wire contract, the deterministic deployment-policy checks, and the KMS maker-key custody
 * attestation are enforced at this boundary: the payload must parse as one versioned structured
 * intent (quote, ratify, revoke, or setup-remediation — see `intent.utils.ts`), the
 * `QUOTER_SIGNER_POLICY` deployment parameter must parse as a complete policy document (see
 * `policy.utils.ts`), the intent must pass every check decidable from those parameters and the
 * middleware clock (see `policy-check.utils.ts`), and the `QUOTER_SIGNER_KMS_KEY_ID` /
 * `QUOTER_SIGNER_KMS_REGION` deployment parameters must address a KMS key whose validated public
 * material derives exactly the policy-pinned maker (see `kms-signer.utils.ts`; the execution role
 * needs `kms:GetPublicKey` on that key, and nothing else, for this stage). The return value is
 * always a versioned approval-or-denial envelope (see `response.utils.ts`). This build remains
 * fail-closed by construction: no encode-and-sign surface is implemented, `kms:Sign` is never
 * called, and every invocation is denied — payloads outside the contract with a typed
 * `MalformedIntentError`, intents against a missing or invalid policy with a typed
 * `PolicyNotConfiguredError`, out-of-policy intents with a typed `IntentPolicyViolationError`
 * naming the violated check, intents against missing or invalid KMS addressing with a typed
 * `KmsNotConfiguredError`, KMS-call failures with a typed retryable `KmsUnavailableError`, custody
 * drift with a typed `KmsAttestationFailedError`, and intents that pass every stage with a typed
 * `SigningNotImplementedError`. Each invocation emits the TIB's `middleware.intent_received` and
 * `middleware.intent_denied` JSON log lines to stdout (CloudWatch Logs), plus
 * `middleware.kms_error` when the attestation stage fails; only allowlisted intent kinds, denial
 * class names, check identifiers, and middleware-owned values are logged, never caller-supplied
 * data. The handler never throws on any payload shape.
 * @param event - Raw, untrusted invocation payload validated against the v1 intent contract.
 * @param context - Lambda context; only `awsRequestId` is read, for log correlation.
 * @returns The versioned fail-closed denial envelope.
 */
export const handler = createHandler()
