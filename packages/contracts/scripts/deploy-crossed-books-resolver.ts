import { CrossedBooksResolver } from '@repo/contracts'
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing required env var: ${name}`); return value }
const rpcUrl = required('RPC_URL'); const key = required('DEPLOYER_PRIVATE_KEY'); const midnightRaw = required('MIDNIGHT_ADDRESS')
if (!isHex(key, { strict: true }) || key.length !== 66) throw new Error('DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
if (!isAddress(midnightRaw, { strict: false })) throw new Error('MIDNIGHT_ADDRESS must be an EVM address')
const { address, factory, factoryData } = CrossedBooksResolver.with(getAddress(midnightRaw))
const transport = http(rpcUrl); const publicClient = createPublicClient({ chain: base, transport }); const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: base, transport })
if (await publicClient.getCode({ address })) { console.log(`CrossedBooksResolver already deployed at ${address}.`); process.exit(0) }
if (!(await publicClient.getCode({ address: factory }))) throw new Error(`CREATE2 factory ${factory} is not deployed`)
const hash = await wallet.sendTransaction({ to: factory, data: factoryData }); const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success' || !(await publicClient.getCode({ address }))) throw new Error(`Deployment failed: ${hash}`)
console.log(`CrossedBooksResolver deployed at ${address} (tx ${hash})`)
