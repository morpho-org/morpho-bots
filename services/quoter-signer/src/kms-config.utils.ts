import { KmsNotConfiguredError } from './kms-not-configured.error'

/**
 * Deployment parameter carrying the AWS KMS key id of the maker key — a key id, key ARN, alias
 * name (`alias/...`), or alias ARN. Like the policy document, KMS addressing lives in the
 * middleware's deployment, never in the request (TIB-2026-08-12): callers cannot select which key
 * signs.
 */
export const QUOTER_SIGNER_KMS_KEY_ID_VARIABLE = 'QUOTER_SIGNER_KMS_KEY_ID'

/**
 * Deployment parameter carrying the AWS region hosting the maker key. Pinned explicitly instead
 * of inherited from the Lambda's own region so a cross-region key deployment stays a reviewed,
 * fail-loud choice.
 */
export const QUOTER_SIGNER_KMS_REGION_VARIABLE = 'QUOTER_SIGNER_KMS_REGION'

/** Deployment-pinned addressing of the AWS KMS maker key used by every signing surface. */
export type KmsSignerConfig = {
  /** KMS key id, key ARN, alias name (`alias/...`), or alias ARN of the maker key. */
  readonly keyId: string
  /** AWS region hosting the maker key, for example `eu-west-1`. */
  readonly region: string
}

// Every KMS key addressing form (id, ARN, alias, alias ARN) stays inside this alphabet; 2048 is
// the documented KeyId request ceiling. The region shape covers standard, GovCloud, China, and
// sovereign-cloud partitions. Both patterns reject whitespace and control characters outright so
// a malformed deployment fails loud instead of reaching the AWS SDK.
const KMS_KEY_ID_PATTERN = /^[A-Za-z0-9:/_-]{1,2048}$/
const AWS_REGION_PATTERN = /^[a-z]{2,8}(-[a-z0-9]+)+$/

const identifierValue = (value: string | undefined, field: string, pattern: RegExp): string => {
  if (value === undefined || value.trim() === '') {
    throw new KmsNotConfiguredError(field, 'missing')
  }
  if (!pattern.test(value)) throw new KmsNotConfiguredError(field, 'invalid-identifier')
  return value
}

/**
 * Strictly parses the KMS maker-key deployment parameters into the typed config.
 *
 * Fail-closed by construction, mirroring the policy parser: an unset or blank variable and any
 * value outside the strict identifier alphabets are rejected, so the signing stage never
 * improvises KMS addressing. There is no default key and no fallback region.
 * @param keyId - Raw `QUOTER_SIGNER_KMS_KEY_ID` environment value, or `undefined` when unset.
 * @param region - Raw `QUOTER_SIGNER_KMS_REGION` environment value, or `undefined` when unset.
 * @returns The validated {@link KmsSignerConfig}.
 * @throws `KmsNotConfiguredError` naming the violating deployment variable and an allowlisted
 * reason — the "refuse to serve" posture for missing or invalid KMS addressing.
 */
export const parseKmsSignerConfig = (
  keyId: string | undefined,
  region: string | undefined
): KmsSignerConfig => ({
  keyId: identifierValue(keyId, QUOTER_SIGNER_KMS_KEY_ID_VARIABLE, KMS_KEY_ID_PATTERN),
  region: identifierValue(region, QUOTER_SIGNER_KMS_REGION_VARIABLE, AWS_REGION_PATTERN)
})
