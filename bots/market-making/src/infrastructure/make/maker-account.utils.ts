import type { Hex, LocalAccount, SignableMessage } from 'viem'

import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { Wallet } from '@ethereumjs/wallet'
import { readFile } from 'node:fs/promises'
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseSignature,
  recoverAddress,
  serializeSignature,
  serializeTransaction
} from 'viem'
import { privateKeyToAccount, publicKeyToAddress, toAccount } from 'viem/accounts'
import { createNonceManager, jsonRpc } from 'viem/nonce'

import type { MakerIdentity } from '../../config/config.service'

import { MakerAccountError } from './maker-account.error'
import { createManagedMakerAccount } from './managed-maker-account.utils'

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_SECP256K1_ORDER = SECP256K1_ORDER / 2n

export type KmsSigner = {
  getPublicKey(keyId: string, region: string): Promise<Uint8Array>
  signDigest(keyId: string, region: string, digest: Uint8Array): Promise<Uint8Array>
}

type MakerAccountDependencies = {
  readFile?: (path: string) => Promise<string>
  decryptKeystore?: (json: string, password: string) => Promise<Hex>
  kms?: KmsSigner
}

const awsKmsSigner: KmsSigner = {
  async getPublicKey(keyId, region) {
    const response = await new KMSClient({ region }).send(new GetPublicKeyCommand({ KeyId: keyId }))
    if (
      !response.PublicKey ||
      response.KeySpec !== 'ECC_SECG_P256K1' ||
      response.KeyUsage !== 'SIGN_VERIFY' ||
      !response.SigningAlgorithms?.includes('ECDSA_SHA_256')
    )
      throw new MakerAccountError('kms-public-key')
    return response.PublicKey
  },
  async signDigest(keyId, region, digest) {
    const response = await new KMSClient({ region }).send(
      new SignCommand({
        KeyId: keyId,
        Message: digest,
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256'
      })
    )
    if (!response.Signature) throw new MakerAccountError('kms-sign')
    return response.Signature
  }
}

const decryptKeystore = async (json: string, password: string): Promise<Hex> => {
  try {
    return bytesToHex((await Wallet.fromV3(json, password)).getPrivateKey())
  } catch {
    throw new MakerAccountError('keystore-decrypt')
  }
}

const publicKeyFromSpki = (spki: Uint8Array): Hex => {
  const publicKey = spki.slice(-65)
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new MakerAccountError('kms-public-key')
  }
  return bytesToHex(publicKey)
}

const derInteger = (bytes: Uint8Array, offset: number) => {
  if (bytes[offset] !== 2) throw new MakerAccountError('kms-sign')
  const length = bytes[offset + 1]
  if (length === undefined || length > 33) throw new MakerAccountError('kms-sign')
  const start = offset + 2
  const end = start + length
  if (end > bytes.length) throw new MakerAccountError('kms-sign')
  return { value: BigInt(bytesToHex(bytes.slice(start, end))), offset: end }
}

const parseDerSignature = (bytes: Uint8Array) => {
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw new MakerAccountError('kms-sign')
  const r = derInteger(bytes, 2)
  const s = derInteger(bytes, r.offset)
  if (
    s.offset !== bytes.length ||
    r.value === 0n ||
    s.value === 0n ||
    r.value >= SECP256K1_ORDER ||
    s.value >= SECP256K1_ORDER
  ) {
    throw new MakerAccountError('kms-sign')
  }
  return { r: r.value, s: s.value > HALF_SECP256K1_ORDER ? SECP256K1_ORDER - s.value : s.value }
}

const createKmsAccount = async (
  identity: Extract<MakerIdentity, { method: 'aws' }>,
  kms: KmsSigner
): Promise<LocalAccount> => {
  let publicKey: Hex
  try {
    publicKey = publicKeyFromSpki(await kms.getPublicKey(identity.keyId, identity.region))
  } catch (error) {
    if (error instanceof MakerAccountError) throw error
    throw new MakerAccountError('kms-public-key')
  }
  const address = publicKeyToAddress(publicKey)
  if (!isAddressEqual(address, identity.maker)) throw new MakerAccountError('kms-public-key')

  const signHash = async (hash: Hex) => {
    let parsed: ReturnType<typeof parseDerSignature>
    try {
      parsed = parseDerSignature(
        await kms.signDigest(identity.keyId, identity.region, hexToBytes(hash))
      )
    } catch (error) {
      if (error instanceof MakerAccountError) throw error
      throw new MakerAccountError('kms-sign')
    }
    const r = numberToHex(parsed.r, { size: 32 })
    const s = numberToHex(parsed.s, { size: 32 })
    for (const yParity of [0, 1] as const) {
      const signature = serializeSignature({ r, s, yParity })
      if (isAddressEqual(await recoverAddress({ hash, signature }), address)) return signature
    }
    throw new MakerAccountError('kms-sign')
  }

  const signTransaction: LocalAccount['signTransaction'] = async (transaction, options) => {
    const serializer = options?.serializer ?? serializeTransaction
    const unsigned = await serializer(transaction)
    const signature = parseSignature(await signHash(keccak256(unsigned)))
    return serializer(transaction, signature)
  }

  const account = toAccount({
    address,
    nonceManager: createNonceManager({ source: jsonRpc() }),
    sign: ({ hash }) => signHash(hash),
    signMessage: ({ message }: { message: SignableMessage }) => signHash(hashMessage(message)),
    signTypedData: typedData => signHash(hashTypedData(typedData as never)),
    signTransaction
  })
  return { ...account, publicKey, source: 'aws-kms' }
}

/** Creates the configured local or remote maker account without ever exporting an AWS KMS key. */
export const createMakerAccount = async (
  identity: Exclude<MakerIdentity, { readOnly: true }>,
  dependencies: MakerAccountDependencies = {}
): Promise<LocalAccount> => {
  if (identity.method === 'private-key') return createManagedMakerAccount(identity.privateKey)
  if (identity.method === 'keystore') {
    let json: string
    try {
      json = await (dependencies.readFile ?? (path => readFile(path, 'utf8')))(identity.path)
    } catch {
      throw new MakerAccountError('keystore-read')
    }
    const privateKey = await (dependencies.decryptKeystore ?? decryptKeystore)(
      json,
      identity.password
    )
    return privateKeyToAccount(privateKey, {
      nonceManager: createNonceManager({ source: jsonRpc() })
    })
  }
  return createKmsAccount(identity, dependencies.kms ?? awsKmsSigner)
}
