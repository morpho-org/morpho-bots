import { CrossedBooksResolver } from '@repo/contracts'
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
const rpcUrl = required('RPC_URL')
const key = required('DEPLOYER_PRIVATE_KEY')
const midnightRaw = required('MIDNIGHT_ADDRESS')
if (!isHex(key, { strict: true }) || key.length !== 66)
  throw new Error('DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
if (!isAddress(midnightRaw, { strict: false }))
  throw new Error('MIDNIGHT_ADDRESS must be an EVM address')
const { address, factory, factoryData } = CrossedBooksResolver.with(getAddress(midnightRaw))
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: base, transport })
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: base, transport })
if (await publicClient.getCode({ address })) {
  console.log(`CrossedBooksResolver already deployed at ${address}.`)
  process.exit(0)
}
if (!(await publicClient.getCode({ address: factory })))
  throw new Error(`CREATE2 factory ${factory} is not deployed`)
const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error(`Deploy tx reverted (${hash})`)

// Same read-after-write lag `deploy-executor.ts` guards against: a confirmed receipt does not
// guarantee the next `getCode` sees the code, so poll before calling a healthy deploy a failure.
let deployed = await publicClient.getCode({ address })
for (let attempt = 0; (!deployed || deployed === '0x') && attempt < 5; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  deployed = await publicClient.getCode({ address })
}
if (!deployed || deployed === '0x')
  throw new Error(`Deploy tx ${hash} succeeded but no code at ${address} after retries`)
console.log(`CrossedBooksResolver deployed at ${address} (tx ${hash})`)
