import type { Address, Hex } from 'viem'

import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  bytesToHex,
  hexToBytes,
  isAddressEqual,
  numberToHex,
  recoverAddress,
  serializeSignature,
  size
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'

import type { KmsSignerConfig } from './kms-config.utils'

import { KmsAttestationFailedError } from './kms-attestation-failed.error'
import { KmsAttestationStaleError } from './kms-attestation-stale.error'
import { KmsSignOutcomeUnknownError } from './kms-sign-outcome-unknown.error'
import { KmsSigningFailedError } from './kms-signing-failed.error'
import { KmsUnavailableError } from './kms-unavailable.error'

/**
 * Milliseconds an attestation stays valid before it must be re-proven against live KMS state.
 * Enforced twice: the handler's resolution cache re-attests past this window, and
 * {@link KmsMakerSigner.signDigest} itself refuses to sign against a stale attestation, so a held
 * signer object cannot outlive its custody proof. Bounds how long key or deployment drift on a
 * warm container can go unnoticed. The TIB's registry-backed freshness window with scheduled
 * refresh and readiness gating is a later increment; until it lands, this constant is the
 * middleware's attestation staleness bound.
 */
export const KMS_ATTESTATION_FRESHNESS_MS = 300_000

/**
 * Raw material of one KMS `GetPublicKey` read. The transport maps AWS response fields verbatim
 * and performs no validation: every custody decision happens in {@link createKmsMakerSigner}, so
 * the checks stay unit-testable instead of hiding inside the thin AWS adapter.
 */
export type KmsPublicKeyMaterial = {
  /** DER-encoded X.509 `SubjectPublicKeyInfo` bytes, when the response carried them. */
  readonly publicKey?: Uint8Array
  /**
   * Resolved key ARN of the key that actually answered (`KeyId` in the AWS response, an ARN even
   * when the request addressed an alias). Signing pins this immutable identifier, never the
   * configured alias, so a repointed alias cannot route a later `Sign` to an unattested key.
   */
  readonly keyArn?: string
  /** Reported key spec; the maker key must be `ECC_SECG_P256K1`. */
  readonly keySpec?: string
  /** Reported key usage; the maker key must be `SIGN_VERIFY`. */
  readonly keyUsage?: string
  /** Reported signing algorithms; the maker key must support `ECDSA_SHA_256`. */
  readonly signingAlgorithms?: readonly string[]
}

/** Raw material of one KMS `Sign` call, mapped verbatim by the transport. */
export type KmsSignatureMaterial = {
  /** DER-encoded ECDSA signature bytes, when the response carried them. */
  readonly signature?: Uint8Array
  /**
   * AWS request id of the `Sign` call — the CloudTrail reconciliation join key each per-artifact
   * signing record must capture (TIB-2026-08-12 Observability).
   */
  readonly kmsRequestId?: string
}

/**
 * Transport boundary for the two KMS operations the middleware performs. The default is
 * {@link awsKmsTransport}; tests inject fakes here so the strict validation on top is covered
 * without AWS. Transport failures are thrown raw and typed by the caller: the read-only
 * attestation call wraps into the retryable `KmsUnavailableError`, while a failed `Sign` call
 * wraps into the non-retryable `KmsSignOutcomeUnknownError` (its outcome is ambiguous).
 */
export type KmsTransport = {
  /** Reads the maker key's public material for the custody attestation. */
  getPublicKey(config: KmsSignerConfig): Promise<KmsPublicKeyMaterial>
  /** Signs one middleware-derived 32-byte digest (`MessageType: 'DIGEST'`). */
  signDigest(config: KmsSignerConfig, digest: Uint8Array): Promise<KmsSignatureMaterial>
}

/** One attested maker signature over a middleware-derived digest. */
export type KmsSignedDigest = {
  /** Serialized 65-byte secp256k1 signature (r ‖ s ‖ v) that recovers to the attested maker. */
  readonly signature: Hex
  /**
   * AWS request id of the KMS `Sign` call. Required: it is the CloudTrail reconciliation join
   * key each per-artifact signing record must capture, so a response without one fails closed
   * instead of producing an unreconcilable signature.
   */
  readonly kmsRequestId: string
}

/**
 * The middleware's attested KMS maker signer: the derived identity plus the one digest-signing
 * primitive the sign-what-you-encode stages call after canonical encoding (TIB-2026-08-12 §2).
 * Deliberately not a generic account: there is no message, typed-data, or transaction surface
 * here — encoding and digest derivation stay with the middleware's own encode stages.
 */
export type KmsMakerSigner = {
  /** Maker address derived from the attested KMS public key. */
  readonly address: Address
  /** Attested uncompressed secp256k1 public key (`0x04 ‖ X ‖ Y`). */
  readonly publicKey: Hex
  /**
   * Signs one middleware-derived digest and verifies the result before returning it.
   * @param digest - 32-byte digest the middleware derived from a validated, canonically encoded
   * intent; never caller-supplied bytes.
   * @returns The low-s, recovery-checked signature and the KMS request id of the call.
   * @throws `KmsAttestationStaleError` when the signer's attestation aged past
   * {@link KMS_ATTESTATION_FRESHNESS_MS} — no KMS call is made and the caller must resolve a
   * fresh signer; `KmsSigningFailedError` when the digest is not 32 bytes or the response cannot
   * be verified; `KmsSignOutcomeUnknownError` when the `Sign` call itself fails — the outcome is
   * ambiguous (a signature may exist server-side), so it is never advertised as retryable.
   */
  signDigest(digest: Hex): Promise<KmsSignedDigest>
}

const kmsClients = new Map<string, KMSClient>()

const kmsClient = (region: string): KMSClient => {
  const cached = kmsClients.get(region)
  if (cached !== undefined) return cached
  // Single attempt, no SDK retries: ECDSA signing is not idempotent, and the TIB's CloudTrail
  // reconciliation requires every `Sign` event to match exactly one middleware signing record — a
  // silent SDK retry would produce surplus events for one artifact. Retry decisions belong to the
  // middleware's typed-denial callers (and later its reservation/idempotency layer), not the
  // transport.
  const client = new KMSClient({ region, maxAttempts: 1 })
  kmsClients.set(region, client)
  return client
}

/**
 * Production transport backed by `@aws-sdk/client-kms`, reusing one client per region for the
 * lifetime of the Lambda execution environment. It maps response fields verbatim — signing uses
 * `MessageType: 'DIGEST'` with `SigningAlgorithm: 'ECDSA_SHA_256'`, the exact call shape the KMS
 * custody TIBs pin — and leaves every validation decision to {@link createKmsMakerSigner}.
 */
export const awsKmsTransport: KmsTransport = {
  async getPublicKey(config) {
    const response = await kmsClient(config.region).send(
      new GetPublicKeyCommand({ KeyId: config.keyId })
    )
    return {
      publicKey: response.PublicKey,
      keyArn: response.KeyId,
      keySpec: response.KeySpec,
      keyUsage: response.KeyUsage,
      signingAlgorithms: response.SigningAlgorithms
    }
  },
  async signDigest(config, digest) {
    const response = await kmsClient(config.region).send(
      new SignCommand({
        KeyId: config.keyId,
        Message: digest,
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256'
      })
    )
    return { signature: response.Signature, kmsRequestId: response.$metadata.requestId }
  }
}

// DER is canonical, so the SubjectPublicKeyInfo of an uncompressed secp256k1 public key has
// exactly one 88-byte encoding: SEQUENCE { SEQUENCE { OID 1.2.840.10045.2.1 (ecPublicKey),
// OID 1.3.132.0.10 (secp256k1) }, BIT STRING (zero unused bits) 0x04 ‖ X ‖ Y }. Strict parsing
// is therefore an exact prefix comparison plus curve validation of the point — no ASN.1 library
// in the root-of-trust image — and every alternative (BER indefinite lengths, other curves,
// compressed points, truncated or trailing bytes) fails closed as a mismatch.
const SPKI_SECP256K1_PREFIX = hexToBytes('0x3056301006072a8648ce3d020106052b8104000a034200')
const SPKI_SECP256K1_LENGTH = SPKI_SECP256K1_PREFIX.length + 65

const publicKeyFromSpki = (spki: Uint8Array): Hex => {
  if (
    spki.length !== SPKI_SECP256K1_LENGTH ||
    !SPKI_SECP256K1_PREFIX.every((byte, index) => spki[index] === byte)
  ) {
    throw new KmsAttestationFailedError('public-key-encoding')
  }
  const point = spki.slice(SPKI_SECP256K1_PREFIX.length)
  try {
    // On-curve validation: rejects fabricated coordinates before an address is derived from them.
    secp256k1.ProjectivePoint.fromHex(point)
  } catch {
    throw new KmsAttestationFailedError('public-key-encoding')
  }
  return bytesToHex(point)
}

const SECP256K1_ORDER = secp256k1.CURVE.n
const HALF_SECP256K1_ORDER = SECP256K1_ORDER / 2n

// Strict canonical DER: exact tags and lengths, no redundant sign padding, integers inside the
// curve order. Mirrors the proven parser of the quoter-bot's direct-KMS maker account; the
// middleware deliberately owns its copy end to end, like its wire and policy parsers, so the
// root of trust stays independently auditable (and free of the bot's asn1js dependency).
const derInteger = (bytes: Uint8Array, offset: number): { value: bigint; offset: number } => {
  if (bytes[offset] !== 2) throw new KmsSigningFailedError('der-encoding')
  const length = bytes[offset + 1]
  if (length === undefined || length === 0 || length > 33) {
    throw new KmsSigningFailedError('der-encoding')
  }
  const start = offset + 2
  const end = start + length
  if (end > bytes.length) throw new KmsSigningFailedError('der-encoding')
  const first = bytes[start]
  const second = bytes[start + 1]
  if (
    first === undefined ||
    (first & 0x80) !== 0 ||
    (first === 0 && length > 1 && second !== undefined && (second & 0x80) === 0) ||
    (length === 33 && first !== 0)
  ) {
    throw new KmsSigningFailedError('der-encoding')
  }
  return { value: BigInt(bytesToHex(bytes.slice(start, end))), offset: end }
}

const parseDerSignature = (bytes: Uint8Array): { r: bigint; s: bigint } => {
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) {
    throw new KmsSigningFailedError('der-encoding')
  }
  const r = derInteger(bytes, 2)
  const s = derInteger(bytes, r.offset)
  if (
    s.offset !== bytes.length ||
    r.value === 0n ||
    s.value === 0n ||
    r.value >= SECP256K1_ORDER ||
    s.value >= SECP256K1_ORDER
  ) {
    throw new KmsSigningFailedError('der-encoding')
  }
  // Low-s normalization: KMS returns whichever s the HSM produced; Ethereum accepts only low-s.
  return { r: r.value, s: s.value > HALF_SECP256K1_ORDER ? SECP256K1_ORDER - s.value : s.value }
}

/**
 * Attests the configured KMS maker key and returns the middleware's digest signer.
 *
 * The attestation is the fail-closed custody gate of TIB-2026-08-12 §3: read the key's public
 * material, require the exact `ECC_SECG_P256K1`/`SIGN_VERIFY`/`ECDSA_SHA_256` shape and the
 * resolved key ARN, strictly
 * parse the canonical uncompressed-secp256k1 SPKI (validating the point is on the curve), derive
 * the maker address, and refuse to serve unless it equals the policy-pinned maker. Signing then
 * pins the attested ARN — never the configured alias, which could be repointed after attestation —
 * and verifies every KMS response before releasing it: strict canonical DER parsing, low-s
 * normalization, and a recovery check across both parities against the attested address — what
 * was attested is what signs, and an unverifiable signature is never returned.
 * @param config - Deployment-pinned KMS key addressing.
 * @param expectedMaker - Policy-pinned maker address the derived key identity must equal.
 * @param transport - KMS transport; defaults to {@link awsKmsTransport}, injectable for tests.
 * @returns The attested {@link KmsMakerSigner}.
 * @throws `KmsUnavailableError` when the `GetPublicKey` call fails (retryable);
 * `KmsAttestationFailedError` when the key material fails any custody check (terminal).
 */
export const createKmsMakerSigner = async (
  config: KmsSignerConfig,
  expectedMaker: Address,
  transport: KmsTransport = awsKmsTransport
): Promise<KmsMakerSigner> => {
  let material: KmsPublicKeyMaterial
  try {
    material = await transport.getPublicKey(config)
  } catch (error) {
    throw new KmsUnavailableError('get-public-key', { cause: error })
  }
  if (
    material.keySpec !== 'ECC_SECG_P256K1' ||
    material.keyUsage !== 'SIGN_VERIFY' ||
    material.signingAlgorithms?.includes('ECDSA_SHA_256') !== true
  ) {
    throw new KmsAttestationFailedError('key-spec')
  }
  const keyArn = material.keyArn
  if (typeof keyArn !== 'string' || !keyArn.startsWith('arn:')) {
    throw new KmsAttestationFailedError('key-arn')
  }
  if (material.publicKey === undefined) throw new KmsAttestationFailedError('missing-public-key')
  const publicKey = publicKeyFromSpki(material.publicKey)
  const address = publicKeyToAddress(publicKey)
  if (!isAddressEqual(address, expectedMaker)) {
    throw new KmsAttestationFailedError('maker-mismatch')
  }
  // Sign against the attested key's immutable ARN, never the configured alias: an alias repointed
  // after attestation must not route a later Sign call to a key this attestation never saw.
  const signingTarget: KmsSignerConfig = { keyId: keyArn, region: config.region }
  const attestedAtMs = Date.now()

  const signDigest = async (digest: Hex): Promise<KmsSignedDigest> => {
    // The attestation ages with the signer object itself: past the freshness window this
    // primitive refuses to sign, so freshness never depends on the caller's cache discipline.
    if (Date.now() - attestedAtMs >= KMS_ATTESTATION_FRESHNESS_MS) {
      throw new KmsAttestationStaleError()
    }
    // The middleware derives every digest itself; anything but 32 bytes is a middleware bug and
    // fails closed before KMS.
    if (size(digest) !== 32) throw new KmsSigningFailedError('digest-width')
    let signed: KmsSignatureMaterial
    try {
      signed = await transport.signDigest(signingTarget, hexToBytes(digest))
    } catch (error) {
      // Ambiguous by construction: the request may have signed server-side with the response
      // lost, so this is never advertised as retryable (see KmsSignOutcomeUnknownError).
      throw new KmsSignOutcomeUnknownError({ cause: error })
    }
    if (signed.signature === undefined) throw new KmsSigningFailedError('missing-signature')
    const kmsRequestId = signed.kmsRequestId
    // A blank id is as unreconcilable as an absent one; a valid id passes through untrimmed.
    if (typeof kmsRequestId !== 'string' || kmsRequestId.trim() === '') {
      throw new KmsSigningFailedError('missing-request-id')
    }
    const parsed = parseDerSignature(signed.signature)
    const r = numberToHex(parsed.r, { size: 32 })
    const s = numberToHex(parsed.s, { size: 32 })
    for (const yParity of [0, 1] as const) {
      const signature = serializeSignature({ r, s, yParity })
      try {
        if (isAddressEqual(await recoverAddress({ hash: digest, signature }), address)) {
          return { signature, kmsRequestId }
        }
      } catch {
        // Try the other recovery parity; a signature recovering to neither fails below.
      }
    }
    throw new KmsSigningFailedError('recovery')
  }

  return { address, publicKey, signDigest }
}
