import { describe, expect, it } from 'vitest'

import type { KmsConfigurationReason } from '../src/kms-not-configured.error'

import { parseKmsSignerConfig } from '../src/kms-config.utils'
import { KmsNotConfiguredError } from '../src/kms-not-configured.error'

const expectNotConfigured = (
  keyId: string | undefined,
  region: string | undefined,
  field: string,
  reason: KmsConfigurationReason
) => {
  let caught: unknown
  try {
    parseKmsSignerConfig(keyId, region)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(KmsNotConfiguredError)
  expect(caught).toMatchObject({ field, reason, retryable: false })
}

describe('parseKmsSignerConfig', () => {
  it.each([
    ['a key id', '1234abcd-12ab-34cd-56ef-1234567890ab', 'eu-west-1'],
    [
      'a key ARN',
      'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
      'eu-west-1'
    ],
    ['an alias name', 'alias/quoter-signer-maker', 'us-east-1'],
    [
      'an alias ARN in a GovCloud region',
      'arn:aws-us-gov:kms:us-gov-west-1:123456789012:alias/quoter-signer-maker',
      'us-gov-west-1'
    ]
  ])('parses %s', (_name, keyId, region) => {
    expect(parseKmsSignerConfig(keyId, region)).toStrictEqual({ keyId, region })
  })

  it.each<[string, string | undefined, string | undefined, string, KmsConfigurationReason]>([
    ['an unset key id', undefined, 'eu-west-1', 'QUOTER_SIGNER_KMS_KEY_ID', 'missing'],
    ['a blank key id', '   ', 'eu-west-1', 'QUOTER_SIGNER_KMS_KEY_ID', 'missing'],
    ['an unset region', 'alias/maker', undefined, 'QUOTER_SIGNER_KMS_REGION', 'missing'],
    ['a blank region', 'alias/maker', '', 'QUOTER_SIGNER_KMS_REGION', 'missing'],
    [
      'a key id with whitespace',
      'alias/maker key',
      'eu-west-1',
      'QUOTER_SIGNER_KMS_KEY_ID',
      'invalid-identifier'
    ],
    [
      'a key id outside the KMS alphabet',
      'alias/maker\n',
      'eu-west-1',
      'QUOTER_SIGNER_KMS_KEY_ID',
      'invalid-identifier'
    ],
    [
      'an uppercase region',
      'alias/maker',
      'EU-WEST-1',
      'QUOTER_SIGNER_KMS_REGION',
      'invalid-identifier'
    ],
    [
      'a bare region word',
      'alias/maker',
      'europe',
      'QUOTER_SIGNER_KMS_REGION',
      'invalid-identifier'
    ],
    [
      'a region with a trailing dash',
      'alias/maker',
      'eu-west-',
      'QUOTER_SIGNER_KMS_REGION',
      'invalid-identifier'
    ]
  ])('fails closed on %s', (_name, keyId, region, field, reason) => {
    expectNotConfigured(keyId, region, field, reason)
  })
})
