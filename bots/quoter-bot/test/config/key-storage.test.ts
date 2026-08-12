import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ConfigValidationError } from '../../src/config/config-validation.error'
import { ConfigService } from '../../src/config/config.service'

const privateKey = `0x${'11'.repeat(32)}`
const baseEnvironment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as const,
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444',
  MARKET_IDS: `0x${'55'.repeat(32)}`,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}
const directories: string[] = []

const configurationYaml = (identity: string) =>
  `chain:\n  id: 8453\n  rpcUrl: https://yaml-rpc.example\n  archiveRpcUrl: https://archive.example\nidentity:\n${identity}\ncontracts:\n  midnightAddress: 0x2222222222222222222222222222222222222222\n  loanAssetAddress: 0x3333333333333333333333333333333333333333\n  ratifierAddress: 0x4444444444444444444444444444444444444444\napis:\n  morphoBaseUrl: https://api.example\n  routerBaseUrl: https://router.example\nmarkets:\n  allowlist: [0x${'55'.repeat(32)}]\n  referenceMarketId: 0x${'77'.repeat(32)}\nsetup:\n  nativeReserveWei: 10\n  maximumLendExposureAssets: 100\n`

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('maker key storage configuration', () => {
  test('preserves the legacy private-key path and derives an explicit method', () => {
    const config = ConfigService.from({ ...baseEnvironment, MAKER_PRIVATE_KEY: privateKey })
    expect(config.keyStorageMethod).toBe('private-key')
    expect(config.identity).toMatchObject({ method: 'private-key', privateKey })
    expect(JSON.stringify(config.identity)).not.toContain(privateKey)
    expect(inspect(config.identity)).not.toContain(privateKey)
  })

  test('loads a keystore with a direct password without exposing the password through serialization', () => {
    const password = '  correct horse battery staple  '
    const config = ConfigService.from({
      ...baseEnvironment,
      KEY_STORAGE_METHOD: 'keystore',
      KEYSTORE_PATH: '/secure/maker.json',
      KEYSTORE_PASSWORD: password
    })
    expect(config.keyStorageMethod).toBe('keystore')
    expect(config.identity).toMatchObject({
      method: 'keystore',
      path: '/secure/maker.json',
      password
    })
    expect(JSON.stringify(config)).not.toContain(password)
    expect(inspect(config)).not.toContain(password)
    expect(JSON.stringify(config.identity)).not.toContain(password)
    expect(inspect(config.identity)).not.toContain(password)
  })

  test('rejects only a truly empty keystore password while preserving whitespace byte-for-byte', () => {
    expect(
      ConfigService.from({
        ...baseEnvironment,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_PASSWORD: ' \t秘密🔐 '
      }).identity
    ).toMatchObject({ method: 'keystore', password: ' \t秘密🔐 ' })

    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_PASSWORD: ''
      })
    ).toThrow(ConfigValidationError)
  })

  test('loads a keystore password from the interactive reader', async () => {
    const readPassword = vi.fn(async () => '  prompted-秘密🔐  ')
    const config = await ConfigService.load(
      {
        ...baseEnvironment,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_INTERACTIVE: 'true'
      },
      { readPassword }
    )
    expect(readPassword).toHaveBeenCalledTimes(1)
    expect(config.identity).toMatchObject({ method: 'keystore', password: '  prompted-秘密🔐  ' })
  })

  test('normalizes keystore selectors before resolving an empty interactive password', async () => {
    const readPassword = vi.fn(async () => 'prompted-password')
    const config = await ConfigService.load(
      {
        ...baseEnvironment,
        MAKER_PRIVATE_KEY: undefined,
        KEY_STORAGE_METHOD: ' keystore ',
        KEYSTORE_PATH: ' /secure/maker.json ',
        KEYSTORE_PASSWORD: '',
        KEYSTORE_INTERACTIVE: ' true '
      },
      { readPassword }
    )

    expect(readPassword).toHaveBeenCalledTimes(1)
    expect(config.identity).toMatchObject({ method: 'keystore', password: 'prompted-password' })
  })

  test('selects non-exportable AWS KMS signing with required key and region', () => {
    const config = ConfigService.from({
      ...baseEnvironment,
      KEY_STORAGE_METHOD: 'aws',
      AWS_KMS_KEY_ID: 'alias/quoter',
      AWS_REGION: 'eu-west-1'
    })
    expect(config.keyStorageMethod).toBe('aws')
    expect(config.identity).toMatchObject({
      method: 'aws',
      keyId: 'alias/quoter',
      region: 'eu-west-1'
    })
    expect(config.privateKey).toBeUndefined()
  })

  test('ignores ambient AWS region and blank companion sentinels outside KMS mode', () => {
    const config = ConfigService.from({
      ...baseEnvironment,
      KEY_STORAGE_METHOD: 'private-key',
      MAKER_PRIVATE_KEY: privateKey,
      KEYSTORE_PASSWORD: ' ',
      AWS_REGION: 'us-east-1'
    })

    expect(config.identity).toMatchObject({ method: 'private-key', privateKey })
  })

  test('read-only mode ignores conflicting ambient environment signer sources', () => {
    const config = ConfigService.from(
      {
        ...baseEnvironment,
        KEY_STORAGE_METHOD: 'aws',
        MAKER_PRIVATE_KEY: privateKey,
        KEYSTORE_PATH: '/ambient/maker.json',
        KEYSTORE_PASSWORD: 'ambient-password',
        AWS_KMS_KEY_ID: 'alias/ambient',
        AWS_REGION: 'eu-west-1'
      },
      { readOnly: true }
    )

    expect(config.identity).toEqual({
      readOnly: true,
      maker: baseEnvironment.MAKER_ADDRESS
    })
    expect(config.keyStorageMethod).toBeUndefined()
  })

  test.each([
    [
      'conflicting private key and keystore',
      {
        MAKER_PRIVATE_KEY: privateKey,
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_PASSWORD: 'pw'
      }
    ],
    [
      'conflicting keystore password modes',
      { KEYSTORE_PATH: '/secure/maker.json', KEYSTORE_PASSWORD: 'pw', KEYSTORE_INTERACTIVE: 'true' }
    ],
    ['missing keystore password mode', { KEYSTORE_PATH: '/secure/maker.json' }],
    ['missing AWS key id', { KEY_STORAGE_METHOD: 'aws', AWS_REGION: 'eu-west-1' }],
    ['missing AWS region', { KEY_STORAGE_METHOD: 'aws', AWS_KMS_KEY_ID: 'alias/maker' }],
    ['missing every source', {}]
  ])('rejects %s', (_name, values) => {
    expect(() => ConfigService.from({ ...baseEnvironment, ...values })).toThrow(
      ConfigValidationError
    )
  })

  test('environment source selection overrides the YAML source while scalar environment values still win', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-key-storage-'))
    directories.push(directory)
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      `chain:\n  id: 8453\n  rpcUrl: https://yaml-rpc.example\n  archiveRpcUrl: https://archive.example\nidentity:\n  makerAddress: 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n  keyStorageMethod: private-key\n  makerPrivateKey: ${privateKey}\ncontracts:\n  midnightAddress: 0x2222222222222222222222222222222222222222\n  loanAssetAddress: 0x3333333333333333333333333333333333333333\n  ratifierAddress: 0x4444444444444444444444444444444444444444\napis:\n  morphoBaseUrl: https://api.example\n  routerBaseUrl: https://router.example\nmarkets:\n  allowlist: [0x${'55'.repeat(32)}]\n  referenceMarketId: 0x${'77'.repeat(32)}\nsetup:\n  nativeReserveWei: 10\n  maximumLendExposureAssets: 100\n`
    )
    const config = await ConfigService.load(
      {
        KEY_STORAGE_METHOD: 'aws',
        AWS_KMS_KEY_ID: 'alias/from-env',
        AWS_REGION: 'us-east-1',
        RPC_URL: 'https://env-rpc.example'
      },
      { configPath: path }
    )
    expect(config.keyStorageMethod).toBe('aws')
    expect(config.identity).toMatchObject({ method: 'aws', keyId: 'alias/from-env' })
    expect(config.rpcUrl).toBe('https://env-rpc.example')
  })

  test.each([
    [
      'private-key',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: private-key\n  makerPrivateKey: ${privateKey}`,
      { KEY_STORAGE_METHOD: ' \t ', MAKER_PRIVATE_KEY: '' },
      { method: 'private-key', privateKey }
    ],
    [
      'keystore',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: keystore\n  keystorePath: /yaml/maker.json\n  keystorePassword: yaml-password`,
      {
        KEY_STORAGE_METHOD: '',
        KEYSTORE_PATH: ' \t ',
        KEYSTORE_PASSWORD: '',
        KEYSTORE_INTERACTIVE: '   '
      },
      { method: 'keystore', path: '/yaml/maker.json', password: 'yaml-password' }
    ],
    [
      'aws',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: aws\n  awsKmsKeyId: alias/yaml-maker\n  awsRegion: eu-west-1`,
      { KEY_STORAGE_METHOD: '\n', AWS_KMS_KEY_ID: ' \t', AWS_REGION: '  ' },
      { method: 'aws', keyId: 'alias/yaml-maker', region: 'eu-west-1' }
    ]
  ])(
    'blank environment signer selectors do not override valid YAML %s configuration',
    async (_method, identity, signerEnvironment, expectedIdentity) => {
      const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-key-storage-blank-env-'))
      directories.push(directory)
      const path = join(directory, 'operator.yaml')
      await writeFile(path, configurationYaml(identity))

      const config = await ConfigService.load(signerEnvironment, { configPath: path })

      expect(config.identity).toMatchObject(expectedIdentity)
    }
  )

  test('a whitespace-only environment password overrides the YAML password byte-for-byte', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-key-storage-password-env-'))
    directories.push(directory)
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      configurationYaml(
        `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: keystore\n  keystorePath: /yaml/maker.json\n  keystorePassword: yaml-password`
      )
    )

    const config = await ConfigService.load({ KEYSTORE_PASSWORD: ' \t ' }, { configPath: path })

    expect(config.identity).toMatchObject({ method: 'keystore', password: ' \t ' })
  })

  test.each([
    [
      'KEY_STORAGE_METHOD',
      { KEY_STORAGE_METHOD: 'unsupported' },
      'unsupported',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: private-key\n  makerPrivateKey: ${privateKey}`
    ],
    [
      'MAKER_PRIVATE_KEY',
      { MAKER_PRIVATE_KEY: 'not-a-private-key' },
      'invalid-bytes32',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: private-key\n  makerPrivateKey: ${privateKey}`
    ],
    [
      'KEYSTORE_INTERACTIVE',
      { KEYSTORE_INTERACTIVE: 'yes' },
      'invalid-boolean',
      `  makerAddress: ${baseEnvironment.MAKER_ADDRESS}\n  keyStorageMethod: keystore\n  keystorePath: /yaml/maker.json\n  keystorePassword: yaml-password`
    ]
  ])(
    'non-blank malformed %s still reaches final validation',
    async (_field, signerEnvironment, reason, identity) => {
      const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-key-storage-invalid-env-'))
      directories.push(directory)
      const path = join(directory, 'operator.yaml')
      await writeFile(path, configurationYaml(identity))

      await expect(
        ConfigService.load(signerEnvironment, { configPath: path })
      ).rejects.toMatchObject({
        reason
      })
    }
  )
})
