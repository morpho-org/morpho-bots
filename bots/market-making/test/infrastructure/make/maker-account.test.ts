import { Wallet } from '@ethereumjs/wallet'
import { secp256k1 } from '@noble/curves/secp256k1'
import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hashMessage, recoverAddress, recoverTransactionAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { createMakerAccount } from '../../../src/infrastructure/make/maker-account.utils'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address

describe('maker signer selection', () => {
  test('creates the legacy local private-key signer', async () => {
    const account = await createMakerAccount({
      readOnly: false,
      maker,
      method: 'private-key',
      privateKey
    })
    expect(account.address).toBe(maker)
    expect(
      await recoverAddress({
        hash: hashMessage('legacy'),
        signature: await account.signMessage({ message: 'legacy' })
      })
    ).toBe(maker)
  })

  test('decrypts a keystore only at the signer boundary', async () => {
    const password = 'keystore-secret'
    const readFile = mock(async () => '{"encrypted":true}')
    const decryptKeystore = mock(async (json: string, suppliedPassword: string) => {
      expect(json).toContain('encrypted')
      expect(suppliedPassword).toBe(password)
      return privateKey
    })
    const account = await createMakerAccount(
      { readOnly: false, maker, method: 'keystore', path: '/secure/maker.json', password },
      { readFile, decryptKeystore }
    )
    expect(account.address).toBe(maker)
    expect(readFile).toHaveBeenCalledWith('/secure/maker.json')
    expect(decryptKeystore).toHaveBeenCalledTimes(1)
  })

  test('decrypts and signs with a real Web3 Secret Storage keystore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-maker-keystore-'))
    const path = join(directory, 'maker.json')
    const password = 'actual-keystore-password'
    try {
      const wallet = Wallet.fromPrivateKey(Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex')))
      await writeFile(path, await wallet.toV3String(password))
      const account = await createMakerAccount({
        readOnly: false,
        maker,
        method: 'keystore',
        path,
        password
      })
      const signature = await account.signMessage({ message: 'real keystore' })
      expect(await recoverAddress({ hash: hashMessage('real keystore'), signature })).toBe(maker)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('uses AWS KMS for non-exportable remote signing and recovers the configured maker', async () => {
    const secret = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'))
    const publicKey = secp256k1.getPublicKey(secret, false)
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...publicKey
    ])
    const getPublicKey = mock(async () => spki)
    const signDigest = mock(async (_keyId: string, _region: string, digest: Uint8Array) =>
      secp256k1.sign(digest, secret, { lowS: false }).toDERRawBytes()
    )
    const account = await createMakerAccount(
      {
        readOnly: false,
        maker,
        method: 'aws',
        keyId: 'alias/market-maker',
        region: 'eu-west-1'
      },
      { kms: { getPublicKey, signDigest } }
    )
    const message = 'kms remote signing'
    const signature = await account.signMessage({ message })
    expect(await recoverAddress({ hash: hashMessage(message), signature })).toBe(maker)
    const transaction = await account.signTransaction({
      chainId: 8453,
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
      to: maker,
      type: 'eip1559',
      value: 1n
    })
    expect(
      await recoverTransactionAddress({ serializedTransaction: transaction as `0x02${string}` })
    ).toBe(maker)
    expect(getPublicKey).toHaveBeenCalledWith('alias/market-maker', 'eu-west-1')
    expect(signDigest).toHaveBeenCalledWith(
      'alias/market-maker',
      'eu-west-1',
      Uint8Array.from(Buffer.from(hashMessage(message).slice(2), 'hex'))
    )
    expect(bytesToHex(publicKey)).not.toBe(privateKey)
  })
})
