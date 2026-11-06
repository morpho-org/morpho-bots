import path from 'node:path'

import { kernelOnlySigning } from '../src/kernel-only-signing'
import { ruleTester } from './rule-tester'

const kernel = path.join('bots', 'quoter-bot', 'src', 'kernel.ts')
const botFile = path.join('bots', 'quoter-bot', 'src', 'bootstrap.ts')

const signerImport = "import { privateKeyToAccount } from 'viem/accounts'"
const broadcast =
  'export const send = (client, raw) => client.sendRawTransaction({ serializedTransaction: raw })'

ruleTester.run('kernel-only-signing', kernelOnlySigning, {
  valid: [
    { code: signerImport, filename: kernel },
    { code: broadcast, filename: kernel },
    {
      code: "import { createAccountSigner, createKmsAccount } from '@repo/kit'",
      filename: kernel
    },
    { code: signerImport, filename: path.join('bots', 'quoter-bot', 'test', 'kernel.test.ts') },
    {
      code: signerImport,
      filename: path.join('bots', 'midnight-liquidation', 'scripts', 'seed.ts')
    },
    { code: signerImport, filename: path.join('packages', 'kit', 'src', 'signer-account.ts') },
    {
      code: "import { createPublicClient, http, readContract } from 'viem'",
      filename: botFile
    },
    { code: "const config = await import('./config.ts')", filename: botFile },
    { code: "import type { HDKey } from 'viem/accounts'", filename: botFile },
    { code: "import { type HDKey } from 'viem/accounts'", filename: botFile },
    { code: "export { type HDKey } from 'viem/accounts'", filename: botFile }
  ],
  invalid: [
    { code: signerImport, filename: botFile, errors: 2 },
    { code: broadcast, filename: botFile, errors: 1 },
    {
      code: signerImport,
      filename: path.join('bots', 'quoter-bot', 'src', 'infrastructure', 'kernel.ts'),
      errors: 2
    },
    { code: "import { type HDKey, toAccount } from 'viem/accounts'", filename: botFile, errors: 2 },
    { code: "import 'viem/accounts'", filename: botFile, errors: 1 },
    { code: 'account.signUserOperation(userOperation)', filename: botFile, errors: 1 },
    { code: "import { KMSClient } from '@aws-sdk/client-kms'", filename: botFile, errors: 1 },
    { code: "import { Wallet } from '@ethereumjs/wallet'", filename: botFile, errors: 1 },
    { code: "import { secp256k1 } from '@noble/curves/secp256k1'", filename: botFile, errors: 1 },
    { code: "import { createWalletClient } from 'viem'", filename: botFile, errors: 1 },
    { code: "import { signTypedData } from 'viem/actions'", filename: botFile, errors: 1 },
    { code: "import { createKmsAccount } from '@repo/kit'", filename: botFile, errors: 1 },
    { code: "export { toAccount } from './kernel.ts'", filename: botFile, errors: 1 },
    { code: "export * from 'viem/accounts'", filename: botFile, errors: 1 },
    {
      code: "import * as viem from 'viem'\nviem.createWalletClient({})",
      filename: botFile,
      errors: 1
    },
    { code: "const accounts = await import('viem/accounts')", filename: botFile, errors: 1 },
    { code: 'const module = await import(name)', filename: botFile, errors: 1 },
    { code: "const kms = require('@aws-sdk/client-kms')", filename: botFile, errors: 1 },
    { code: "account['signMessage']({ message: 'm' })", filename: botFile, errors: 1 },
    { code: 'account[`signTransaction`](request)', filename: botFile, errors: 1 },
    {
      code: "client.request({ method: 'eth_sendRawTransaction', params: [raw] })",
      filename: botFile,
      errors: 1
    },
    {
      code: "client.request({ method: 'wallet_sendCalls', params: [calls] })",
      filename: botFile,
      errors: 1
    },
    {
      code: "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)",
      filename: botFile,
      errors: 2
    },
    { code: "import { writeContracts } from 'viem/experimental'", filename: botFile, errors: 1 },
    { code: "import { createSigner } from '@repo/bot-kit'", filename: botFile, errors: 1 }
  ]
})
