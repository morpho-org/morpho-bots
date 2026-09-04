import type { Tree } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import type { ChainReadTransport } from './chain-read.utils'
import type { IntentFees, IntentOffer, QuoterSignerIntent } from './intent.utils'
import type { KmsSignerConfig } from './kms-config.utils'
import type { KmsMakerSigner, KmsTransport } from './kms-signer.utils'
import type { QuoterSignerPolicy } from './policy.utils'
import type {
  EncodedPublication,
  QuoterSignerApprovalResult,
  QuoterSignerResponse
} from './response.utils'
import type { EncodableRevokeOperation } from './transaction-encode.utils'

import { ArtifactEncodingFailedError } from './artifact-encoding-failed.error'
import { readMakerPendingNonce, viemChainReadTransport } from './chain-read.utils'
import { IntentPolicyViolationError } from './intent-policy-violation.error'
import { classifyIntentKind, parseQuoterSignerIntent } from './intent.utils'
import { KmsAttestationFailedError } from './kms-attestation-failed.error'
import { KmsAttestationStaleError } from './kms-attestation-stale.error'
import {
  parseKmsSignerConfig,
  QUOTER_SIGNER_KMS_KEY_ID_VARIABLE,
  QUOTER_SIGNER_KMS_REGION_VARIABLE
} from './kms-config.utils'
import { KmsNotConfiguredError } from './kms-not-configured.error'
import { KmsSignOutcomeUnknownError } from './kms-sign-outcome-unknown.error'
import {
  awsKmsTransport,
  createKmsMakerSigner,
  KMS_ATTESTATION_FRESHNESS_MS
} from './kms-signer.utils'
import { KmsSigningFailedError } from './kms-signing-failed.error'
import { KmsUnavailableError } from './kms-unavailable.error'
import { emitJsonLine } from './log.utils'
import { MalformedIntentError } from './malformed-intent.error'
import {
  buildIntentOfferTree,
  deriveEcrecoverTreeDigest,
  encodeEcrecoverPublication,
  encodeSetterPublication,
  preflightEcrecoverPublication
} from './offer-tree.utils'
import { assertIntentWithinPolicy } from './policy-check.utils'
import { PolicyNotConfiguredError } from './policy-not-configured.error'
import { parseQuoterSignerPolicy, QUOTER_SIGNER_POLICY_VARIABLE } from './policy.utils'
import { buildApprovalResponse, buildDenialResponse } from './response.utils'
import { RpcChainMismatchError } from './rpc-chain-mismatch.error'
import { parseRpcConfig, QUOTER_SIGNER_RPC_URL_VARIABLE } from './rpc-config.utils'
import { RpcNotConfiguredError } from './rpc-not-configured.error'
import { RpcUnavailableError } from './rpc-unavailable.error'
import { SigningNotImplementedError } from './signing-not-implemented.error'
import { encodeRatifyRootCall, encodeRevokeOperationCall } from './transaction-encode.utils'
import {
  assembleSignedTransaction,
  buildMakerTransaction,
  deriveMakerTransactionDigest
} from './transaction-sign.utils'

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
  | KmsAttestationStaleError
  | KmsSigningFailedError
  | KmsSignOutcomeUnknownError
  | RpcNotConfiguredError
  | RpcUnavailableError
  | RpcChainMismatchError
  | ArtifactEncodingFailedError
  | SigningNotImplementedError

/** Resolves the attested maker signer for one deployment key/maker pair. */
type KmsSignerResolver = (config: KmsSignerConfig, maker: Address) => Promise<KmsMakerSigner>

/** Records one successful `kms:Sign` call for the per-artifact audit trail. */
type KmsSignRecorder = (digest: Hex, kmsRequestId: string) => void

/** One approved-and-signed evaluation: the response payload plus its audit-line fields. */
type SignedIntentOutcome = {
  /** Per-kind approval payload for the response envelope. */
  readonly approval: QuoterSignerApprovalResult
  /** Middleware-owned fields the `middleware.intent_approved` line reports. */
  readonly approvedRecord: Record<string, unknown>
}

/** The evaluation pipeline's terminal states: a signed outcome or a typed denial. */
type EvaluationResult =
  | { readonly outcome: SignedIntentOutcome }
  | { readonly denial: QuoterSignerDenialCause }

const currentUnixSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000))

/** One re-derived Ecrecover quote ready to sign: the tree and its EIP-712 digest. */
type PreparedQuote = {
  readonly tree: Tree
  readonly digest: Hex
}

/**
 * Re-derives the offer tree, its EIP-712 digest, and the publication-encodability preflight for
 * one quote intent — every caller-decidable encoding rejection happens here, before the KMS
 * custody attestation, so caller mistakes still cost no KMS traffic.
 */
const prepareQuoteIntent = async (
  offers: readonly IntentOffer[],
  policy: QuoterSignerPolicy
): Promise<PreparedQuote> => {
  const tree = buildIntentOfferTree(offers, policy)
  const digest = deriveEcrecoverTreeDigest(tree, policy.chainId)
  // Publication-encodability preflight: catches the API's offer-struct rules before KMS, so an
  // unpublishable set denies without spending the intent's one Sign call.
  await preflightEcrecoverPublication(tree)
  return { tree, digest }
}

/**
 * Signs a prepared Ecrecover quote: the intent's exactly-one `kms:Sign` call over the tree
 * digest, then the publication payload assembled from the returned signature.
 */
const signQuoteIntent = async (parameters: {
  readonly prepared: PreparedQuote
  readonly policy: QuoterSignerPolicy
  readonly signer: KmsMakerSigner
  readonly recordKmsSign: KmsSignRecorder
}): Promise<SignedIntentOutcome> => {
  const { prepared, policy, signer, recordKmsSign } = parameters
  const signed = await signer.signDigest(prepared.digest)
  recordKmsSign(prepared.digest, signed.kmsRequestId)
  const publication = await encodeEcrecoverPublication({
    tree: prepared.tree,
    maker: signer.address,
    signature: signed.signature,
    mempool: policy.contracts.mempool
  })
  return {
    approval: {
      kind: 'quote',
      root: prepared.tree.root,
      treeSignature: signed.signature,
      publication
    },
    approvedRecord: { root: prepared.tree.root, kmsSignCalls: 1 }
  }
}

/** One re-derived Setter ratification ready to sign: the tree plus its publication payload. */
type PreparedRatification = {
  readonly tree: Tree
  readonly publication: EncodedPublication
}

/**
 * Re-derives the offer tree and the (signature-free) Setter publication payload for one ratify
 * intent — every caller-decidable encoding rejection happens here, before the nonce read and the
 * KMS custody attestation.
 */
const prepareRatifyIntent = async (
  offers: readonly IntentOffer[],
  policy: QuoterSignerPolicy
): Promise<PreparedRatification> => {
  const tree = buildIntentOfferTree(offers, policy)
  return {
    tree,
    publication: await encodeSetterPublication({ tree, mempool: policy.contracts.mempool })
  }
}

/**
 * Signs a prepared Setter ratification: the `setIsRootRatified(maker, root, true)` transaction
 * at the independently read nonce — one `kms:Sign` call per transaction artifact.
 */
const signRatifyIntent = async (parameters: {
  readonly prepared: PreparedRatification
  readonly fees: IntentFees
  readonly policy: QuoterSignerPolicy
  readonly signer: KmsMakerSigner
  readonly nonce: number
  readonly recordKmsSign: KmsSignRecorder
}): Promise<SignedIntentOutcome> => {
  const { prepared, fees, policy, signer, nonce, recordKmsSign } = parameters
  const { tree, publication } = prepared
  const transaction = buildMakerTransaction({
    chainId: policy.chainId,
    nonce,
    call: encodeRatifyRootCall(tree.root, policy),
    fees
  })
  const digest = deriveMakerTransactionDigest(transaction)
  const signed = await signer.signDigest(digest)
  recordKmsSign(digest, signed.kmsRequestId)
  const artifact = assembleSignedTransaction(transaction, fees, signed)
  return {
    approval: { kind: 'ratify', root: tree.root, transaction: artifact, publication },
    approvedRecord: { root: tree.root, nonce, transactionHash: artifact.hash, kmsSignCalls: 1 }
  }
}

/**
 * Signs one revoke transaction: canonically encode the allowlisted operation, then sign it at
 * the independently read nonce — one `kms:Sign` call for the single transaction artifact.
 */
const signRevokeIntent = async (parameters: {
  readonly operation: EncodableRevokeOperation
  readonly fees: IntentFees
  readonly policy: QuoterSignerPolicy
  readonly signer: KmsMakerSigner
  readonly nonce: number
  readonly recordKmsSign: KmsSignRecorder
}): Promise<SignedIntentOutcome> => {
  const { operation, fees, policy, signer, nonce, recordKmsSign } = parameters
  const transaction = buildMakerTransaction({
    chainId: policy.chainId,
    nonce,
    call: encodeRevokeOperationCall(operation, policy),
    fees
  })
  const digest = deriveMakerTransactionDigest(transaction)
  const signed = await signer.signDigest(digest)
  recordKmsSign(digest, signed.kmsRequestId)
  const artifact = assembleSignedTransaction(transaction, fees, signed)
  return {
    approval: { kind: 'revoke', transaction: artifact },
    approvedRecord: {
      operation: operation.type,
      nonce,
      transactionHash: artifact.hash,
      kmsSignCalls: 1
    }
  }
}

/** Maps a signing-stage throw onto its typed denial; unexpected faults stay fail-closed. */
const signingDenial = (error: unknown): QuoterSignerDenialCause => {
  if (
    error instanceof IntentPolicyViolationError ||
    error instanceof KmsAttestationStaleError ||
    error instanceof KmsSigningFailedError ||
    error instanceof KmsSignOutcomeUnknownError ||
    error instanceof ArtifactEncodingFailedError
  ) {
    return error
  }
  // An unexpected signing-stage fault is a middleware bug; it still denies, never approves.
  return new IntentPolicyViolationError('internal-fault', 'intent', { cause: error })
}

/** Resolves the attested signer, mapping faults onto the pipeline's typed KMS denials. */
const attestSigner = async (
  resolveSigner: KmsSignerResolver,
  config: KmsSignerConfig,
  maker: Address
): Promise<{ readonly signer: KmsMakerSigner } | { readonly denial: QuoterSignerDenialCause }> => {
  try {
    return { signer: await resolveSigner(config, maker) }
  } catch (error) {
    if (error instanceof KmsUnavailableError || error instanceof KmsAttestationFailedError) {
      return { denial: error }
    }
    // An unexpected resolution fault proved nothing about the key; fail closed but retryable.
    return { denial: new KmsUnavailableError('get-public-key', { cause: error }) }
  }
}

/** Reads the maker's pending nonce, mapping faults onto the typed read-failure denials. */
const readNonce = async (
  policy: QuoterSignerPolicy,
  chainRead: ChainReadTransport
): Promise<{ readonly nonce: number } | { readonly denial: QuoterSignerDenialCause }> => {
  let rpcConfig
  try {
    rpcConfig = parseRpcConfig(process.env[QUOTER_SIGNER_RPC_URL_VARIABLE])
  } catch (error) {
    return {
      denial:
        error instanceof RpcNotConfiguredError
          ? error
          : new RpcNotConfiguredError(QUOTER_SIGNER_RPC_URL_VARIABLE, 'invalid-url')
    }
  }
  try {
    const nonce = await readMakerPendingNonce(
      rpcConfig,
      { chainId: policy.chainId, maker: policy.maker },
      chainRead
    )
    return { nonce }
  } catch (error) {
    if (error instanceof RpcUnavailableError || error instanceof RpcChainMismatchError) {
      return { denial: error }
    }
    // An unexpected read fault proved nothing about the chain; fail closed but retryable.
    return { denial: new RpcUnavailableError('pending-nonce', { cause: error }) }
  }
}

/**
 * Runs the fail-closed evaluation pipeline over one untrusted invocation payload. Stage order is
 * the permanent contract: wire-contract parse, deployment policy load, deterministic policy
 * checks, then — for the implemented ladder create/move surfaces — the independent pending-nonce
 * read for transaction kinds, the KMS maker-key custody attestation, canonical encoding, and the
 * `kms:Sign` call, with the typed denial or signed outcome as the only terminal states. Each
 * stage maps unexpected faults onto its own typed denial so the handler can never throw and never
 * approves by accident. The chain reads run before any KMS activity, so a read failure is a typed
 * retryable denial with no KMS call; the attestation runs after every caller-decidable check, so
 * caller mistakes are answered without KMS traffic. Setup-remediation intents, self-cancel
 * revocations, and the whole break-glass-revoke surface remain denied with the typed
 * not-implemented cause: they require the recorded transaction inventory (which break-glass
 * needs to replace occupied nonces instead of queueing at the pending one), the occupied-nonce
 * enumeration, and the remediation epochs of later TIB-2026-08-12 increments.
 */
const evaluateIntent = async (
  event: unknown,
  dependencies: {
    readonly resolveSigner: KmsSignerResolver
    readonly chainRead: ChainReadTransport
    readonly recordKmsSign: KmsSignRecorder
  }
): Promise<EvaluationResult> => {
  const { resolveSigner, chainRead, recordKmsSign } = dependencies
  let intent: QuoterSignerIntent
  try {
    intent = parseQuoterSignerIntent(event)
  } catch (error) {
    // The parser only throws MalformedIntentError; anything else still fails closed as malformed.
    return {
      denial:
        error instanceof MalformedIntentError
          ? error
          : new MalformedIntentError('intent', 'wrong-type')
    }
  }
  let policy: QuoterSignerPolicy
  try {
    policy = parseQuoterSignerPolicy(process.env[QUOTER_SIGNER_POLICY_VARIABLE])
  } catch (error) {
    // A policy that cannot be parsed refuses to serve; unexpected faults collapse to the same.
    return {
      denial:
        error instanceof PolicyNotConfiguredError
          ? error
          : new PolicyNotConfiguredError('policy', 'wrong-type')
    }
  }
  try {
    assertIntentWithinPolicy(intent, policy, currentUnixSeconds())
  } catch (error) {
    // An unexpected evaluation fault is a middleware bug; it still denies, never approves.
    return {
      denial:
        error instanceof IntentPolicyViolationError
          ? error
          : new IntentPolicyViolationError('internal-fault', 'intent')
    }
  }
  let kmsConfig: KmsSignerConfig
  try {
    kmsConfig = parseKmsSignerConfig(
      process.env[QUOTER_SIGNER_KMS_KEY_ID_VARIABLE],
      process.env[QUOTER_SIGNER_KMS_REGION_VARIABLE]
    )
  } catch (error) {
    // KMS addressing that cannot be parsed refuses to serve, like the policy document.
    return {
      denial:
        error instanceof KmsNotConfiguredError
          ? error
          : new KmsNotConfiguredError('kms', 'invalid-identifier')
    }
  }
  // Setup remediation needs the remediation epochs and manifest-state reads of later increments;
  // self-cancel needs the recorded-transaction inventory. Both stay typed not-implemented.
  if (intent.kind === 'setup-remediation') return { denial: new SigningNotImplementedError() }
  if (intent.kind === 'quote') {
    let prepared: PreparedQuote
    try {
      prepared = await prepareQuoteIntent(intent.offers, policy)
    } catch (error) {
      return { denial: signingDenial(error) }
    }
    const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
    if ('denial' in attested) return attested
    try {
      return {
        outcome: await signQuoteIntent({
          prepared,
          policy,
          signer: attested.signer,
          recordKmsSign
        })
      }
    } catch (error) {
      return { denial: signingDenial(error) }
    }
  }
  if (intent.kind === 'revoke') {
    const operation = intent.operation
    if (operation.type === 'self-cancel') return { denial: new SigningNotImplementedError() }
    // Break-glass revocation must REPLACE every occupied nonce, never queue at the pending one —
    // "a next-unused-nonce revocation cannot preempt the pending stream" (TIB §5). That takeover
    // needs the recorded occupied-nonce inventory of the reservation-ledger increment, so the
    // surface stays honestly denied rather than signing a cleanup that waits behind the very
    // transactions it should displace. Routine revocation at the pending nonce is unaffected.
    if (policy.surface === 'break-glass-revoke') {
      return { denial: new SigningNotImplementedError() }
    }
    const read = await readNonce(policy, chainRead)
    if ('denial' in read) return read
    const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
    if ('denial' in attested) return attested
    try {
      return {
        outcome: await signRevokeIntent({
          operation,
          fees: intent.fees,
          policy,
          signer: attested.signer,
          nonce: read.nonce,
          recordKmsSign
        })
      }
    } catch (error) {
      return { denial: signingDenial(error) }
    }
  }
  let prepared: PreparedRatification
  try {
    prepared = await prepareRatifyIntent(intent.offers, policy)
  } catch (error) {
    return { denial: signingDenial(error) }
  }
  const read = await readNonce(policy, chainRead)
  if ('denial' in read) return read
  const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
  if ('denial' in attested) return attested
  try {
    return {
      outcome: await signRatifyIntent({
        prepared,
        fees: intent.fees,
        policy,
        signer: attested.signer,
        nonce: read.nonce,
        recordKmsSign
      })
    }
  } catch (error) {
    return { denial: signingDenial(error) }
  }
}

/** Injectable dependencies of {@link createHandler}; production uses the AWS-backed defaults. */
export type HandlerDependencies = {
  /** KMS transport override; defaults to the `@aws-sdk/client-kms`-backed transport. */
  readonly kms?: KmsTransport
  /** Chain-read transport override; defaults to the viem-public-client-backed transport. */
  readonly chainRead?: ChainReadTransport
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

/** Emits the TIB-2026-08-12 KMS failure event for the denials that involve KMS state. */
const emitKmsDenialEvent = (
  denial: QuoterSignerDenialCause,
  intentKind: string,
  awsRequestId: string | undefined
): void => {
  if (denial instanceof KmsUnavailableError) {
    emitJsonLine({
      event: 'middleware.kms_error',
      intentKind,
      awsRequestId,
      operation: denial.operation
    })
    return
  }
  if (denial instanceof KmsSigningFailedError) {
    // A post-call rejection means the Sign call itself completed — a CloudTrail Sign event
    // exists — so the per-artifact reconciliation record is still emitted before the failure.
    if (denial.digest !== undefined) {
      emitJsonLine({
        event: 'middleware.kms_sign',
        intentKind,
        awsRequestId,
        digest: denial.digest,
        ...(denial.kmsRequestId !== undefined ? { kmsRequestId: denial.kmsRequestId } : {})
      })
    }
    emitJsonLine({ event: 'middleware.kms_error', intentKind, awsRequestId, reason: denial.reason })
    return
  }
  if (denial instanceof KmsAttestationFailedError) {
    emitJsonLine({ event: 'middleware.kms_error', intentKind, awsRequestId, reason: denial.reason })
    return
  }
  if (denial instanceof KmsAttestationStaleError) {
    emitJsonLine({
      event: 'middleware.kms_error',
      intentKind,
      awsRequestId,
      reason: 'attestation-stale'
    })
    return
  }
  if (denial instanceof KmsSignOutcomeUnknownError) {
    emitJsonLine({
      event: 'middleware.kms_error',
      intentKind,
      awsRequestId,
      reason: 'sign-outcome-unknown'
    })
  }
}

/** Emits the TIB-2026-08-12 independent-read failure event for the chain-read denials. */
const emitReadDenialEvent = (
  denial: QuoterSignerDenialCause,
  intentKind: string,
  awsRequestId: string | undefined
): void => {
  if (denial instanceof RpcUnavailableError) {
    emitJsonLine({
      event: 'middleware.read_failed',
      intentKind,
      awsRequestId,
      operation: denial.operation
    })
    return
  }
  if (denial instanceof RpcChainMismatchError) {
    emitJsonLine({
      event: 'middleware.read_failed',
      intentKind,
      awsRequestId,
      operation: 'chain-id',
      reason: 'chain-mismatch'
    })
  }
}

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
 * factory is also the test seam for injecting fake KMS and chain-read transports.
 * @param dependencies - Optional transport and warm-up overrides; omit in production.
 * @returns The Lambda handler documented on {@link handler}.
 */
export const createHandler = (dependencies: HandlerDependencies = {}): QuoterSignerHandler => {
  const transport = dependencies.kms ?? awsKmsTransport
  const chainRead = dependencies.chainRead ?? viemChainReadTransport
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
    // The per-artifact signing record of the TIB's Observability contract: emitted immediately
    // after each verified Sign call, before any later assembly stage can fail; the denial path
    // emits the same record for a Sign call whose response failed verification, so every
    // CloudTrail Sign event has exactly one middleware record even when the intent still denies.
    const recordKmsSign: KmsSignRecorder = (digest, kmsRequestId) =>
      emitJsonLine({ event: 'middleware.kms_sign', intentKind, awsRequestId, digest, kmsRequestId })
    const result = await evaluateIntent(event, { resolveSigner, chainRead, recordKmsSign })
    if ('outcome' in result) {
      emitJsonLine({
        event: 'middleware.intent_approved',
        intentKind,
        awsRequestId,
        ...result.outcome.approvedRecord
      })
      return buildApprovalResponse(result.outcome.approval)
    }
    const denial = result.denial
    emitKmsDenialEvent(denial, intentKind, awsRequestId)
    emitReadDenialEvent(denial, intentKind, awsRequestId)
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
 * This build implements the encode-and-sign surfaces of the ladder create/move flow on top of the
 * v1 wire contract, the deterministic deployment-policy checks, and the KMS maker-key custody
 * attestation. The payload must parse as one versioned structured intent (see `intent.utils.ts`),
 * the `QUOTER_SIGNER_POLICY` deployment parameter must parse as a complete policy document —
 * now including the pinned Midnight singleton and Mempool contracts and each allowlisted
 * market's full immutable parameter struct, re-derived to its pinned market id (see
 * `policy.utils.ts`) — the intent must pass every deterministic check (see
 * `policy-check.utils.ts`), and the KMS deployment parameters must address a key whose validated
 * public material derives exactly the policy-pinned maker (see `kms-signer.utils.ts`).
 *
 * An intent that passes every stage is then canonically encoded and signed
 * (sign-what-you-encode; the execution role now needs `kms:Sign` on the maker key in addition to
 * `kms:GetPublicKey`): a quote re-derives the offer tree with the pinned maker and market structs
 * injected, verifies every content-addressed group id, signs the EIP-712 tree digest — exactly
 * one `kms:Sign` call — and returns the tree signature plus the encoded zero-value Mempool
 * publication payload; a ratify re-validates the offer set, re-derives the root, and signs the
 * `setIsRootRatified(maker, root, true)` transaction; a routine revoke signs the exact
 * allowlisted group-consumption (`setConsumed(group, MAX_OFFER_CAP, maker)`, capped at the wire's
 * group limit and batched as one singleton `multicall` built solely from such calls),
 * `cancelRoot(maker, root)`, or
 * `setIsRootRatified(maker, root, false)` call. Transaction kinds commit to the maker's pending
 * nonce read through the middleware's own `QUOTER_SIGNER_RPC_URL` endpoint (chain id verified
 * against the policy pin on every read) and to caller-supplied fee fields already checked against
 * the deployment ceilings; the value is always zero. Approvals return the versioned envelope of
 * `response.utils.ts` with the exact payloads the middleware encoded.
 *
 * Everything else stays fail-closed with typed denials: malformed payloads, missing or invalid
 * policy/KMS/RPC configuration, out-of-policy intents (including group ids that do not re-derive
 * from the offer contents), chain-read failures (retryable, with no KMS call), custody drift,
 * KMS signing failures, and — still — setup-remediation intents, self-cancel revocations, and
 * the break-glass-revoke surface, which require the recorded transaction inventory (break-glass
 * cleanup must replace occupied nonces, never queue at the pending one) and remediation epochs of
 * later TIB increments. The reservation ledger, nonce leases, aggregate signed-exposure accounting, and
 * independent book/PnL reads also remain later increments: passing this build's checks charges no
 * durable reservation. Each invocation emits the TIB's JSON log lines to stdout:
 * `middleware.intent_received`, then `middleware.kms_sign` per successful Sign call (derived
 * digest + KMS request id, the CloudTrail reconciliation join key), and finally
 * `middleware.intent_approved` or `middleware.intent_denied`, plus `middleware.kms_error` /
 * `middleware.read_failed` on the corresponding failures; only allowlisted intent kinds, denial
 * class names, check identifiers, and middleware-owned values are logged, never caller-supplied
 * data. The handler never throws on any payload shape.
 * @param event - Raw, untrusted invocation payload validated against the v1 intent contract.
 * @param context - Lambda context; only `awsRequestId` is read, for log correlation.
 * @returns The versioned approval envelope, or the versioned fail-closed denial envelope.
 */
export const handler = createHandler()
