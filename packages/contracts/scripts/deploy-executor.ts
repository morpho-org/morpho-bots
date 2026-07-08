/**
 * One-shot, idempotent deployment of the generic Executor singleton to its deterministic CREATE2
 * address via the canonical Foundry/Arachnid deterministic-deployment-proxy. Reuses `Executor.with()`
 * so the deployed address provably matches the bot's derived address and the deployless lens (one
 * salt, one source of truth). The Executor has no constructor, so the bytecode — and therefore the
 * address — is identical on every chain (given the pinned solc + optimizer settings).
 *
 * Run once per chain:
 *
 *   RPC_URL=… DEPLOYER_PRIVATE_KEY=… bun run --filter @repo/contracts deploy:executor
 *
 * Idempotent: a no-op (exit 0) if the deterministic address already holds code.
 */
import { Executor } from '@repo/contracts'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  extractChain,
  http,
  isHex
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'

function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

const rpcUrl = required('RPC_URL')
const privateKey = required('DEPLOYER_PRIVATE_KEY')
if (!isHex(privateKey, { strict: true }) || privateKey.length !== 66) {
  throw new Error('DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
}

// The deterministic address + the exact factory call (factoryData = salt ++ initcode), straight from
// soltag — the same values the bot derives and the deployless lens uses.
const { address, factory, factoryData } = Executor.with()
const account = privateKeyToAccount(privateKey)

const transport = http(rpcUrl)
// Resolve the chain from the live chain id so the script is chain-agnostic (any chain that has the
// canonical factory). Known chains carry their EIP-1559 fee defaults; unknown ids get a minimal shim.
const chainId = await createPublicClient({ transport }).getChainId()
const chain =
  extractChain({ chains: Object.values(chains), id: chainId as (typeof chains.base)['id'] }) ??
  defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })

const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })

const existing = await publicClient.getCode({ address })
if (existing && existing !== '0x') {
  console.log(`Executor already deployed at ${address} on chain ${chainId} — nothing to do.`)
  process.exit(0)
}

const factoryCode = await publicClient.getCode({ address: factory })
if (!factoryCode || factoryCode === '0x') {
  throw new Error(
    `Canonical CREATE2 factory ${factory} is not deployed on chain ${chainId}; cannot deploy deterministically.`
  )
}

console.log(`Deploying Executor to ${address} via factory ${factory} on chain ${chainId}…`)
const hash = await walletClient.sendTransaction({ to: factory, data: factoryData })
const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error(`Deploy tx reverted (${hash})`)

// The tx is confirmed successful, so the code IS deposited — but some RPCs (e.g. Alchemy on newer
// Orbit chains) serve `getCode` with brief read-after-write lag right after the receipt, returning
// `0x` for a moment. Poll a few times before declaring failure so a healthy deploy isn't reported
// as a false negative.
let deployed = await publicClient.getCode({ address })
for (let attempt = 0; (!deployed || deployed === '0x') && attempt < 5; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  deployed = await publicClient.getCode({ address })
}
if (!deployed || deployed === '0x')
  throw new Error(`Deploy tx ${hash} succeeded but no code at ${address} after retries`)

console.log(`Executor deployed at ${address} (tx ${hash})`)
