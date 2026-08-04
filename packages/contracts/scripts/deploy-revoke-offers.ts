import { RevokeOffers } from '@repo/contracts'
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import { RevokeOffersDeploymentError } from './revoke-offers-deployment.error'

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new RevokeOffersDeploymentError(`Missing required env var: ${name}`)
  return value
}

const rpcUrl = required('RPC_URL')
const key = required('DEPLOYER_PRIVATE_KEY')
const midnightRaw = required('MIDNIGHT_ADDRESS')
if (!isHex(key, { strict: true }) || key.length !== 66) {
  throw new RevokeOffersDeploymentError(
    'DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
  )
}
if (!isAddress(midnightRaw, { strict: false })) {
  throw new RevokeOffersDeploymentError('MIDNIGHT_ADDRESS must be an EVM address')
}

const { address, factory, factoryData } = RevokeOffers.with(getAddress(midnightRaw))
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: base, transport })
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: base, transport })
const deployedCode = await publicClient.getCode({ address })
if (deployedCode !== undefined && deployedCode !== '0x') {
  console.log(`RevokeOffers already deployed at ${address}.`)
  process.exit(0)
}
const factoryCode = await publicClient.getCode({ address: factory })
if (factoryCode === undefined || factoryCode === '0x') {
  throw new RevokeOffersDeploymentError('CREATE2 factory is not deployed')
}
const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
const receipt = await publicClient.waitForTransactionReceipt({ hash })
const confirmedCode = await publicClient.getCode({ address })
if (receipt.status !== 'success' || confirmedCode === undefined || confirmedCode === '0x') {
  throw new RevokeOffersDeploymentError('Deployment failed')
}
console.log(`RevokeOffers deployed at ${address} (tx ${hash})`)
