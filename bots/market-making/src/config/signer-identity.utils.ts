import type { Address, Hex } from 'viem'

import { inspect } from 'node:util'

import type { Environment } from './config.utils'

import { ConfigValidationError } from './config-validation.error'
import { privateKeyValue } from './config.utils'

/** Validated maker identity selected by the CLI runtime mode. */
export type MakerIdentity =
  | { readOnly: true; maker: Address }
  | { readOnly: false; maker: Address; method: 'private-key'; privateKey: Hex }
  | { readOnly: false; maker: Address; method: 'keystore'; path: string; password: string }
  | { readOnly: false; maker: Address; method: 'aws'; keyId: string; region: string }

const protectedIdentity = <Identity extends Exclude<MakerIdentity, { readOnly: true }>>(
  identity: Identity
) => {
  for (const secret of ['privateKey', 'password'] as const) {
    if (secret in identity) {
      Object.defineProperty(identity, secret, {
        value: identity[secret as keyof Identity],
        writable: false,
        enumerable: false,
        configurable: false
      })
    }
  }
  return Object.defineProperties(identity, {
    toJSON: {
      value: () => ({ readOnly: false, maker: identity.maker, method: identity.method })
    },
    [inspect.custom]: {
      value: () => `MakerIdentity ${inspect({ maker: identity.maker, method: identity.method })}`
    }
  })
}

const required = (values: Environment, name: string) => {
  const value = values[name]?.trim()
  if (!value) throw new ConfigValidationError(name, 'missing', `Missing required env var: ${name}`)
  return value
}

/**
 * Selects and validates one write-enabled signer identity.
 * @param environment - Merged signer configuration after source precedence has been applied.
 * @param maker - Checksummed maker address the selected credential must control.
 * @returns A serialization-protected private-key, keystore, or AWS KMS identity.
 * @throws `ConfigValidationError` when signer selection or required companion values are invalid.
 * @remarks This function performs no filesystem, network, prompt, or signing side effects.
 */
export const signerIdentity = (environment: Environment, maker: Address): MakerIdentity => {
  const declared = environment.KEY_STORAGE_METHOD?.trim()
  if (declared && !['private-key', 'keystore', 'aws'].includes(declared)) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'unsupported',
      'KEY_STORAGE_METHOD must be private-key, keystore, or aws'
    )
  }
  const selected = [
    environment.MAKER_PRIVATE_KEY?.trim() ? 'private-key' : undefined,
    environment.KEYSTORE_PATH?.trim() ? 'keystore' : undefined,
    environment.AWS_KMS_KEY_ID?.trim() ? 'aws' : undefined
  ].filter((value): value is 'private-key' | 'keystore' | 'aws' => value !== undefined)
  if (selected.length > 1 || (declared && selected.some(value => value !== declared))) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  const method = (declared ?? selected[0]) as 'private-key' | 'keystore' | 'aws' | undefined
  if (!method) {
    throw new ConfigValidationError(
      'MAKER_PRIVATE_KEY',
      'missing',
      'Missing required env var: MAKER_PRIVATE_KEY'
    )
  }
  if (method === 'private-key') {
    if (
      environment.KEYSTORE_PATH?.trim() ||
      environment.KEYSTORE_INTERACTIVE?.trim() === 'true' ||
      environment.AWS_KMS_KEY_ID?.trim()
    ) {
      throw new ConfigValidationError(
        'KEY_STORAGE_METHOD',
        'conflicting-sources',
        'Exactly one maker key storage method must be configured'
      )
    }
    return protectedIdentity({
      readOnly: false,
      maker,
      method,
      privateKey: privateKeyValue(environment)
    })
  }
  if (method === 'keystore') {
    if (environment.AWS_KMS_KEY_ID?.trim()) {
      throw new ConfigValidationError(
        'KEY_STORAGE_METHOD',
        'conflicting-sources',
        'Exactly one maker key storage method must be configured'
      )
    }
    const password = environment.KEYSTORE_PASSWORD
    const interactive = environment.KEYSTORE_INTERACTIVE?.trim()
    if (interactive !== undefined && interactive !== 'true' && interactive !== 'false') {
      throw new ConfigValidationError(
        'KEYSTORE_INTERACTIVE',
        'invalid-boolean',
        'KEYSTORE_INTERACTIVE must be true or false'
      )
    }
    if (
      (password !== undefined && password.length > 0 ? 1 : 0) + (interactive === 'true' ? 1 : 0) !==
      1
    ) {
      throw new ConfigValidationError(
        'KEYSTORE_PASSWORD',
        'password-mode',
        'Keystore signing requires exactly one of a password or interactive prompt'
      )
    }
    if (password === undefined || password.length === 0) {
      throw new ConfigValidationError(
        'KEYSTORE_PASSWORD',
        'interactive-unresolved',
        'Interactive keystore password was not provided'
      )
    }
    return protectedIdentity({
      readOnly: false,
      maker,
      method,
      path: required(environment, 'KEYSTORE_PATH'),
      password
    })
  }
  if (environment.KEYSTORE_PATH?.trim() || environment.KEYSTORE_INTERACTIVE?.trim() === 'true') {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  return protectedIdentity({
    readOnly: false,
    maker,
    method,
    keyId: required(environment, 'AWS_KMS_KEY_ID'),
    region: required(environment, 'AWS_REGION')
  })
}
