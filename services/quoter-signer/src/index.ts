import type { Tree } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import type { ChainReadTransport, MakerNonceWindow } from './chain-read.utils'
import type { IntentFees, IntentOffer, QuoterSignerIntent } from './intent.utils'
import type { KmsSignerConfig } from './kms-config.utils'
import type { KmsMakerSigner, KmsTransport } from './kms-signer.utils'
import type { PolicyRemediation, QuoterSignerPolicy } from './policy.utils'
import type {
  EncodedPublication,
  QuoterSignerApprovalResult,
  QuoterSignerResponse,
  SignedTransactionArtifact
} from './response.utils'
import type { RpcConfig } from './rpc-config.utils'
import type { RpcReadOperation } from './rpc-unavailable.error'
import type { EncodableRevokeOperation, EncodedContractCall } from './transaction-encode.utils'

import { ArtifactEncodingFailedError } from './artifact-encoding-failed.error'
import {
  readMakerAllowance,
  readMakerNonceWindow,
  readMakerPendingNonce,
  viemChainReadTransport
} from './chain-read.utils'
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
import {
  encodeRatifyRootCall,
  encodeRemediationActionCall,
  encodeRevokeOperationCall,
  encodeSelfCancelCall
} from './transaction-encode.utils'
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

/** One canonically encoded maker call ready to sign at a validated nonce. */
type MakerSigningRequest = {
  readonly call: EncodedContractCall
  readonly fees: IntentFees
  readonly policy: QuoterSignerPolicy
  readonly signer: KmsMakerSigner
  readonly nonce: number
  readonly recordKmsSign: KmsSignRecorder
}

/**
 * Signs one canonically encoded maker transaction — the single `kms:Sign` call every transaction
 * kind performs, recorded immediately after the verified response so the per-artifact audit line
 * exists before any assembly stage can fail.
 */
const signMakerTransaction = async (
  parameters: MakerSigningRequest
): Promise<SignedTransactionArtifact> => {
  const { call, fees, policy, signer, nonce, recordKmsSign } = parameters
  const transaction = buildMakerTransaction({ chainId: policy.chainId, nonce, call, fees })
  const digest = deriveMakerTransactionDigest(transaction)
  const signed = await signer.signDigest(digest)
  recordKmsSign(digest, signed.kmsRequestId)
  return assembleSignedTransaction(transaction, fees, signed)
}

/**
 * Signs a prepared Setter ratification: the `setIsRootRatified(maker, root, true)` transaction
 * at the independently read nonce — one `kms:Sign` call per transaction artifact.
 */
const signRatifyIntent = async (
  parameters: Omit<MakerSigningRequest, 'call'> & { readonly prepared: PreparedRatification }
): Promise<SignedIntentOutcome> => {
  const { prepared, policy, nonce } = parameters
  const { tree, publication } = prepared
  const artifact = await signMakerTransaction({
    ...parameters,
    call: encodeRatifyRootCall(tree.root, policy)
  })
  return {
    approval: { kind: 'ratify', root: tree.root, transaction: artifact, publication },
    approvedRecord: { root: tree.root, nonce, transactionHash: artifact.hash, kmsSignCalls: 1 }
  }
}

/**
 * Signs one revoke transaction: canonically encode the allowlisted operation, then sign it at
 * the validated nonce — one `kms:Sign` call for the single transaction artifact.
 */
const signRevokeIntent = async (
  parameters: Omit<MakerSigningRequest, 'call'> & {
    readonly operation: EncodableRevokeOperation
  }
): Promise<SignedIntentOutcome> => {
  const { operation, policy, nonce } = parameters
  const artifact = await signMakerTransaction({
    ...parameters,
    call: encodeRevokeOperationCall(operation, policy)
  })
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

/**
 * Signs one self-cancel: the empty zero-value self-send at the window-validated nonce — the
 * replacement payload that carries no economic action (TIB-2026-08-12 §1).
 */
const signSelfCancelIntent = async (
  parameters: Omit<MakerSigningRequest, 'call'>
): Promise<SignedIntentOutcome> => {
  const { policy, nonce } = parameters
  const artifact = await signMakerTransaction({ ...parameters, call: encodeSelfCancelCall(policy) })
  return {
    approval: { kind: 'revoke', transaction: artifact },
    approvedRecord: {
      operation: 'self-cancel',
      nonce,
      transactionHash: artifact.hash,
      kmsSignCalls: 1
    }
  }
}

/**
 * Signs one setup remediation: the manifest-pinned `approve(spender, amount)` at the
 * independently read pending nonce — one `kms:Sign` call for the single transaction artifact.
 */
const signRemediationIntent = async (
  parameters: Omit<MakerSigningRequest, 'call'> & { readonly remediation: PolicyRemediation }
): Promise<SignedIntentOutcome> => {
  const { remediation, nonce } = parameters
  const artifact = await signMakerTransaction({
    ...parameters,
    call: encodeRemediationActionCall(remediation.action)
  })
  return {
    approval: { kind: 'setup-remediation', transaction: artifact },
    approvedRecord: {
      remediation: remediation.variant,
      nonce,
      transactionHash: artifact.hash,
      kmsSignCalls: 1
    }
  }
}

/**
 * Seconds of remaining offer lifetime the pre-sign recheck demands beyond the fresh clock
 * reading, covering the work the recheck itself cannot see: the KMS `Sign` call, publication
 * assembly, response delivery, and the caller's broadcast hand-off. An offer expiring inside
 * this margin would be signed into an artifact that is unusable (or, for a ratification,
 * broadcastable only to waste the nonce) by the time the caller holds it.
 */
const PRE_SIGN_LIFETIME_MARGIN_SECONDS = 30n

/**
 * Re-runs the deterministic policy checks on a fresh clock reading, for the offer-carrying kinds
 * whose time windows (expiry, start age) can cross a boundary during the pre-sign awaits — the
 * chain reads and the KMS custody attestation. A set that aged out of policy while those ran is
 * denied with the normal typed time-window violation instead of being signed into an artifact
 * the caller can no longer use. Returns `undefined` when the intent still passes.
 * @param marginSeconds - Extra seconds of lifetime to demand beyond the clock reading; the
 * initial intake check passes zero (its upper-bound checks stay authoritative), the pre-sign
 * recheck passes {@link PRE_SIGN_LIFETIME_MARGIN_SECONDS} to cover signing and delivery.
 */
const recheckIntentClock = (
  intent: QuoterSignerIntent,
  policy: QuoterSignerPolicy,
  marginSeconds: bigint
): { readonly denial: QuoterSignerDenialCause } | undefined => {
  try {
    assertIntentWithinPolicy(intent, policy, currentUnixSeconds() + marginSeconds)
    return undefined
  } catch (error) {
    // An unexpected evaluation fault is a middleware bug; it still denies, never approves.
    return {
      denial:
        error instanceof IntentPolicyViolationError
          ? error
          : new IntentPolicyViolationError('internal-fault', 'intent')
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

/** Resolves the deployment's RPC addressing, mapping faults onto the typed denial. */
const resolveRpcConfig = ():
  | { readonly config: RpcConfig }
  | { readonly denial: QuoterSignerDenialCause } => {
  try {
    return { config: parseRpcConfig(process.env[QUOTER_SIGNER_RPC_URL_VARIABLE]) }
  } catch (error) {
    return {
      denial:
        error instanceof RpcNotConfiguredError
          ? error
          : new RpcNotConfiguredError(QUOTER_SIGNER_RPC_URL_VARIABLE, 'invalid-url')
    }
  }
}

/** Maps a chain-read throw onto its typed denial; unexpected faults stay retryable-closed. */
const chainReadDenial = (
  error: unknown,
  operation: RpcReadOperation
): { readonly denial: QuoterSignerDenialCause } => {
  if (error instanceof RpcUnavailableError || error instanceof RpcChainMismatchError) {
    return { denial: error }
  }
  // An unexpected read fault proved nothing about the chain; fail closed but retryable.
  return { denial: new RpcUnavailableError(operation, { cause: error }) }
}

/** Reads the maker's pending nonce, mapping faults onto the typed read-failure denials. */
const readNonce = async (
  policy: QuoterSignerPolicy,
  chainRead: ChainReadTransport
): Promise<{ readonly nonce: number } | { readonly denial: QuoterSignerDenialCause }> => {
  const rpc = resolveRpcConfig()
  if ('denial' in rpc) return rpc
  try {
    const nonce = await readMakerPendingNonce(
      rpc.config,
      { chainId: policy.chainId, maker: policy.maker },
      chainRead
    )
    return { nonce }
  } catch (error) {
    return chainReadDenial(error, 'pending-nonce')
  }
}

/** Reads the maker's replaceable nonce window, mapping faults onto the typed denials. */
const readNonceWindow = async (
  policy: QuoterSignerPolicy,
  chainRead: ChainReadTransport
): Promise<
  { readonly window: MakerNonceWindow } | { readonly denial: QuoterSignerDenialCause }
> => {
  const rpc = resolveRpcConfig()
  if ('denial' in rpc) return rpc
  try {
    const window = await readMakerNonceWindow(
      rpc.config,
      { chainId: policy.chainId, maker: policy.maker },
      chainRead
    )
    return { window }
  } catch (error) {
    return chainReadDenial(error, 'pending-nonce')
  }
}

/** Reads the remediation action's current allowance, mapping faults onto the typed denials. */
const readRemediationAllowance = async (
  policy: QuoterSignerPolicy,
  remediation: PolicyRemediation,
  chainRead: ChainReadTransport
): Promise<{ readonly allowance: bigint } | { readonly denial: QuoterSignerDenialCause }> => {
  const rpc = resolveRpcConfig()
  if ('denial' in rpc) return rpc
  try {
    const allowance = await readMakerAllowance(
      rpc.config,
      {
        chainId: policy.chainId,
        token: remediation.action.token,
        owner: policy.maker,
        spender: remediation.action.spender
      },
      chainRead
    )
    return { allowance }
  } catch (error) {
    return chainReadDenial(error, 'allowance')
  }
}

/**
 * Runs the fail-closed evaluation pipeline over one untrusted invocation payload. Stage order is
 * the permanent contract: wire-contract parse, deployment policy load, deterministic policy
 * checks, then the independent chain reads each kind requires — the pending-nonce read for
 * routine-placed transaction kinds, the `[latest, pending]` nonce-window read validating every
 * explicit placement (the break-glass operations, self-cancel included), and the allowance-state read
 * gating setup remediation — the KMS maker-key custody attestation, canonical encoding, and the
 * `kms:Sign` call, with the typed denial or signed outcome as the only terminal states. Each
 * stage maps unexpected faults onto its own typed denial so the handler can never throw and never
 * approves by accident. The chain reads run before any KMS activity, so a read failure is a typed
 * retryable denial with no KMS call; the attestation runs after every caller-decidable check, so
 * caller mistakes are answered without KMS traffic.
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
  const checked = recheckIntentClock(intent, policy, 0n)
  if (checked !== undefined) return checked
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
  if (intent.kind === 'quote') {
    let prepared: PreparedQuote
    try {
      prepared = await prepareQuoteIntent(intent.offers, policy)
    } catch (error) {
      return { denial: signingDenial(error) }
    }
    const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
    if ('denial' in attested) return attested
    // Fresh-clock recheck after the awaits, with the signing/delivery margin: an offer set that
    // expired — or will expire before the caller can use the artifact — denies here instead.
    const recheck = recheckIntentClock(intent, policy, PRE_SIGN_LIFETIME_MARGIN_SECONDS)
    if (recheck !== undefined) return recheck
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
    let nonce: number
    if (operation.nonce === undefined) {
      const read = await readNonce(policy, chainRead)
      if ('denial' in read) return read
      nonce = read.nonce
    } else {
      // An explicit placement — break-glass only, self-cancel included, per the policy checks —
      // is signed only inside the independently read `[latest, pending]` window: below it the
      // artifact could never be included, above it it would be a future-nonce stockpile.
      const read = await readNonceWindow(policy, chainRead)
      if ('denial' in read) return read
      if (operation.nonce < read.window.latest || operation.nonce > read.window.pending) {
        return { denial: new IntentPolicyViolationError('nonce-window', 'operation.nonce') }
      }
      nonce = operation.nonce
    }
    const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
    if ('denial' in attested) return attested
    const signing = {
      fees: intent.fees,
      policy,
      signer: attested.signer,
      nonce,
      recordKmsSign
    }
    try {
      return {
        outcome: await (operation.type === 'self-cancel'
          ? signSelfCancelIntent(signing)
          : signRevokeIntent({ ...signing, operation }))
      }
    } catch (error) {
      return { denial: signingDenial(error) }
    }
  }
  if (intent.kind === 'setup-remediation') {
    const remediation = policy.remediations.find(entry => entry.variant === intent.remediation)
    // The deterministic checks already matched the variant; a miss here is a middleware fault.
    if (remediation === undefined) {
      return { denial: new IntentPolicyViolationError('internal-fault', 'remediation') }
    }
    const state = await readRemediationAllowance(policy, remediation, chainRead)
    if ('denial' in state) return state
    // Re-approving the live allowance would burn the nonce and fees without changing state; the
    // middleware's own read decides, so a caller cannot talk it into signing a no-op.
    if (state.allowance === BigInt(remediation.action.amount)) {
      return { denial: new IntentPolicyViolationError('remediation-state', 'remediation') }
    }
    const read = await readNonce(policy, chainRead)
    if ('denial' in read) return read
    const attested = await attestSigner(resolveSigner, kmsConfig, policy.maker)
    if ('denial' in attested) return attested
    try {
      return {
        outcome: await signRemediationIntent({
          remediation,
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
  // Fresh-clock recheck after the awaits, with the signing/delivery margin: an offer set that
  // expired — or will expire before the signed ratification can be used — denies here instead.
  const recheck = recheckIntentClock(intent, policy, PRE_SIGN_LIFETIME_MARGIN_SECONDS)
  if (recheck !== undefined) return recheck
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
 * This build implements the encode-and-sign stages of every v1 intent kind on top of the wire
 * contract, the deterministic deployment-policy checks, and the KMS maker-key custody
 * attestation. The payload must parse as one versioned structured intent (see `intent.utils.ts`),
 * the `QUOTER_SIGNER_POLICY` deployment parameter must parse as a complete policy document —
 * including the pinned Midnight singleton and Mempool contracts, each allowlisted market's full
 * immutable parameter struct re-derived to its pinned market id, and each remediation variant's
 * exact pinned action template (see `policy.utils.ts`) — the intent must pass every
 * deterministic check (see `policy-check.utils.ts`), and the KMS deployment parameters must
 * address a key whose validated public material derives exactly the policy-pinned maker (see
 * `kms-signer.utils.ts`).
 *
 * An intent that passes every stage is then canonically encoded and signed
 * (sign-what-you-encode; a signing execution role needs `kms:Sign` on the maker key in addition
 * to `kms:GetPublicKey`): a quote re-derives the offer tree with the pinned maker and market
 * structs injected, verifies every content-addressed group id, signs the EIP-712 tree digest —
 * exactly one `kms:Sign` call — and returns the tree signature plus the encoded zero-value
 * Mempool publication payload; a ratify re-validates the offer set, re-derives the root, and
 * signs the `setIsRootRatified(maker, root, true)` transaction; a revoke signs the exact
 * allowlisted group-consumption (`setConsumed(group, MAX_OFFER_CAP, maker)`, capped at the wire's
 * group limit and batched as one singleton `multicall` built solely from such calls),
 * `cancelRoot(maker, root)`, or `setIsRootRatified(maker, root, false)` call — on the
 * routine-revoke surface at the middleware's own pending-nonce read, on the break-glass surface
 * at the operator's explicit placement nonce under the protected ceilings — or the empty
 * zero-value self-cancel that replaces the maker's own in-flight transaction (break-glass only:
 * a routine displacement could out-bid a pending cleanup and preserve exposure); and a setup
 * remediation signs the manifest-pinned `approve(spender, amount)` after the middleware's own
 * allowance read proves it changes state. Every explicit placement nonce is validated against
 * the independently read `[latest, pending]` window, so a caller can direct a replacement but
 * never obtain a future-nonce stockpile or an unincludable artifact. Transaction kinds otherwise
 * commit to the maker's pending nonce read through the middleware's own `QUOTER_SIGNER_RPC_URL`
 * endpoint (chain id verified against the policy pin on every read) and to caller-supplied fee
 * fields already checked against the deployment ceilings; the value is always zero. Approvals
 * return the versioned envelope of `response.utils.ts` with the exact payloads the middleware
 * encoded.
 *
 * Everything else stays fail-closed with typed denials: malformed payloads, missing or invalid
 * policy/KMS/RPC configuration, out-of-policy intents (including group ids that do not re-derive
 * from the offer contents, placement nonces outside the live window, and remediations whose
 * pinned allowance already holds), chain-read failures (retryable, with no KMS call), custody
 * drift, and KMS signing failures. The reservation ledger (nonce leases, aggregate
 * signed-exposure and signed-gas accounting, the recorded transaction inventory and its derived
 * replacement fees), the remediation and cleanup epochs, and the independent book/PnL reads
 * remain later TIB increments: passing this build's checks charges no durable reservation, and
 * break-glass placement is operator-directed rather than middleware-enumerated. Each invocation
 * emits the TIB's JSON log lines to stdout:
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
