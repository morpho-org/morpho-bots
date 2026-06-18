import type { Anvil } from '@viem/anvil'
import type { Address, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { createAnvil } from '@viem/anvil'
import { createTestClient, createWalletClient, http, parseEther, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// A real, currently-open Base Midnight position (discovered 2026-06-17, CRTR-2589). The fork is
// pinned at FORK_BLOCK so the position state, the cbBTC oracle, and the cbBTC/USDC pool are all
// deterministic; the suite warps past `maturity` to make it post-maturity liquidatable.
const FORK_BLOCK = 47_482_000n
export const MIDNIGHT = '0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854' as Address
export const POSITION = {
  id: '0xb5d2fb559c07b73e69291a0c65dd32e6953c2cf2fb8ec5d6002e374ca8f89df5' as Hex,
  borrower: '0x6bA008e3F6eC55Dc6412e459Ac67949c6D1620c5' as Address,
  maturity: 1_781_881_200n
} as const

// Base token + Uniswap-V3 venue addresses for this position's market.
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address // loan token
export const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address // collateral token
export const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address
export const POOL_FEE = 100

// Well-known anvil dev keys (throwaway; funded via setBalance on the fork). #0 is the liquidator EOA
// the bot signs with; #1 deploys the Executor singleton (it has no owner, so the deployer is moot).
export const LIQUIDATOR_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const DEPLOYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

export const LIQUIDATOR = privateKeyToAccount(LIQUIDATOR_KEY).address

// Fail loud (no skip) when the fork RPC isn't configured — the suite cannot run without it.
const FORK_URL = process.env.BASE_FORK_RPC_URL
if (!FORK_URL) {
  throw new Error(
    'BASE_FORK_RPC_URL is required for the fork suite — set it in bots/midnight-liquidation/.env.test.local'
  )
}

export type TestClient = ReturnType<typeof testClient>

/**
 * Boots an anvil instance forking Base at FORK_BLOCK (chain id pinned to Base so signatures match).
 * `port` is explicit so multiple fork test files can run in one `bun test` process without colliding.
 */
export async function startFork(port = 8545): Promise<{ anvil: Anvil; rpcUrl: string }> {
  const anvil = createAnvil({
    forkUrl: FORK_URL,
    forkBlockNumber: Number(FORK_BLOCK),
    chainId: base.id,
    port,
    stopTimeout: 15_000
  })
  await anvil.start()
  return { anvil, rpcUrl: `http://${anvil.host}:${anvil.port}` }
}

/**
 * Best-effort teardown. `@viem/anvil`'s `stop()` can hang on lingering keep-alive sockets from the
 * viem clients, so we swallow the timeout — the child process is reaped on bun's exit (execa cleanup).
 */
export async function stopFork(anvil: Anvil | undefined): Promise<void> {
  await anvil?.stop().catch(() => {})
}

/** Anvil cheatcode client (setBalance / setNextBlockTimestamp / mine) + public reads. */
export function testClient(rpcUrl: string) {
  return createTestClient({ chain: base, mode: 'anvil', transport: http(rpcUrl) }).extend(
    publicActions
  )
}

/** Funds `address` with 100 ETH for gas. */
export async function fundEth(test: TestClient, address: Address): Promise<void> {
  await test.setBalance({ address, value: parseEther('100') })
}

/** Warps the chain past `timestamp` and mines a block so the next lens read sees the new time. */
export async function warpTo(test: TestClient, timestamp: bigint): Promise<void> {
  await test.setNextBlockTimestamp({ timestamp })
  await test.mine({ blocks: 1 })
}

/**
 * Deploys the vendored generic Executor singleton from its init bytecode and returns its address
 * (used as the bot's EXECUTOOOR_ADDRESS). Funds the throwaway deployer first.
 */
export async function deployExecutor(test: TestClient, rpcUrl: string): Promise<Address> {
  const account = privateKeyToAccount(DEPLOYER_KEY)
  await test.setBalance({ address: account.address, value: parseEther('100') })
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) }).extend(
    publicActions
  )
  const hash = await wallet.deployContract({ abi: Executor.abi, bytecode: Executor.bytecode() })
  const receipt = await wallet.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('Executor deployment produced no contract address')
  return receipt.contractAddress
}
