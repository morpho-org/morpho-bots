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
  | { readOnly: false; maker: Address; method: 'middleware'; functionArn: string; region: string }

const SIGNER_METHODS = ['private-key', 'keystore', 'aws', 'middleware'] as const

type SignerMethod = (typeof SIGNER_METHODS)[number]

const SIGNER_METHOD_SELECTORS: Readonly<Record<SignerMethod, readonly string[]>> = {
  'private-key': ['MAKER_PRIVATE_KEY'],
  keystore: ['KEYSTORE_PATH'],
  aws: ['AWS_KMS_KEY_ID'],
  middleware: ['QUOTER_SIGNER_LAMBDA_ARN']
}

const selectsMethod = (environment: Environment, method: SignerMethod) =>
  SIGNER_METHOD_SELECTORS[method].some(key => environment[key]?.trim())

const hasForeignSignerSource = (environment: Environment, method: SignerMethod) =>
  SIGNER_METHODS.some(
    candidate =>
      candidate !== method &&
      (selectsMethod(environment, candidate) ||
        (candidate === 'keystore' && environment.KEYSTORE_INTERACTIVE?.trim() === 'true'))
  )

// Function or alias-qualified AWS Lambda ARN in the standard partition; the qualifier charset
// excludes `$`, so `$LATEST` — which TIB-2026-08-12 forbids invoking — never validates.
const LAMBDA_FUNCTION_ARN_PATTERN =
  /^arn:aws:lambda:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:function:[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,128})?$/

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

const middlewareFunctionArn = (environment: Environment) => {
  const functionArn = required(environment, 'QUOTER_SIGNER_LAMBDA_ARN')
  const region = LAMBDA_FUNCTION_ARN_PATTERN.exec(functionArn)?.[1]
  if (region === undefined) {
    throw new ConfigValidationError(
      'QUOTER_SIGNER_LAMBDA_ARN',
      'invalid-arn',
      'QUOTER_SIGNER_LAMBDA_ARN must be an AWS Lambda function or alias ARN'
    )
  }
  return { functionArn, region }
}

/**
 * Selects and validates one write-enabled signer identity.
 * @param environment - Merged signer configuration after source precedence has been applied.
 * @param maker - Checksummed maker address the selected credential must control.
 * @returns A serialization-protected private-key, keystore, AWS KMS, or quoter-signer middleware
 * identity.
 * @throws `ConfigValidationError` when signer selection or required companion values are invalid.
 * @remarks This function performs no filesystem, network, prompt, or signing side effects. The
 * `middleware` method (TIB-2026-08-12) is selected by `QUOTER_SIGNER_LAMBDA_ARN` and derives its
 * AWS region from the ARN itself; it holds no key material — signing flows must go through the
 * middleware intent ports, and any generic signing path fails closed.
 */
export const signerIdentity = (environment: Environment, maker: Address): MakerIdentity => {
  const declared = environment.KEY_STORAGE_METHOD?.trim()
  if (declared && !(SIGNER_METHODS as readonly string[]).includes(declared)) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'unsupported',
      'KEY_STORAGE_METHOD must be private-key, keystore, aws, or middleware'
    )
  }
  const selected = SIGNER_METHODS.filter(candidate => selectsMethod(environment, candidate))
  if (selected.length > 1 || (declared && selected.some(value => value !== declared))) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  const method = (declared ?? selected[0]) as SignerMethod | undefined
  if (!method) {
    throw new ConfigValidationError(
      'MAKER_PRIVATE_KEY',
      'missing',
      'Missing required env var: MAKER_PRIVATE_KEY'
    )
  }
  if (hasForeignSignerSource(environment, method)) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  if (method === 'private-key') {
    return protectedIdentity({
      readOnly: false,
      maker,
      method,
      privateKey: privateKeyValue(environment)
    })
  }
  if (method === 'keystore') {
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
  if (method === 'aws') {
    return protectedIdentity({
      readOnly: false,
      maker,
      method,
      keyId: required(environment, 'AWS_KMS_KEY_ID'),
      region: required(environment, 'AWS_REGION')
    })
  }
  return protectedIdentity({
    readOnly: false,
    maker,
    method,
    ...middlewareFunctionArn(environment)
  })
}
