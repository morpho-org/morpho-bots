import type { Subprocess } from 'bun'
import type { Address, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { ensureError } from '@repo/utils'
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

// Fail loud (no skip) when the fork RPC isn't configured — the suite cannot run without it. Named
// per-chain (8453 = Base) so CI can supply it as a secret of the same name; locally, set it in
// bots/midnight-liquidation/.env.test.local. Resolved via a function so the value is typed `string`
// (a module-level narrowing wouldn't flow into startFork's closure).
function requireForkUrl(): string {
  const url = process.env.RPC_URL_8453
  if (!url) {
    throw new Error(
      'RPC_URL_8453 is required for the fork suite — set it in bots/midnight-liquidation/.env.test.local'
    )
  }
  return url
}
const FORK_URL = requireForkUrl()

export type TestClient = ReturnType<typeof testClient>

// We spawn `anvil` ourselves rather than via `@viem/anvil`, whose `stop()` is broken for forked
// instances: when the process is slow to exit (its keep-alive sockets stall the SIGTERM it sends), an
// internal `stopTimeout` promise escapes as an unhandled "Anvil failed to stop in time" rejection
// that bun's test runner fails the suite on, and the child is left orphaned (port bound for the next
// run). A bare `Bun.spawn` gives us `.kill('SIGKILL')` + `.exited`, which terminate deterministically.
export type ForkHandle = Subprocess

/** Polls the JSON-RPC endpoint until it answers `eth_blockNumber`, so callers see a ready node. */
async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let lastError: Error | undefined
  while (performance.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
      })
      if (res.ok) {
        await res.json()
        return
      }
    } catch (error) {
      lastError = ensureError(error)
    }
    await Bun.sleep(100)
  }
  const detail = lastError ? `: ${lastError.message}` : ''
  throw new Error(`anvil RPC at ${url} not ready within ${timeoutMs}ms${detail}`)
}

/**
 * Boots an anvil instance forking Base at FORK_BLOCK (chain id pinned to Base so signatures match).
 * `port` is explicit so multiple fork test files can run in one `bun test` process without colliding.
 * Requires the `anvil` binary on PATH (Foundry locally; foundry-toolchain in CI).
 */
export async function startFork(port = 8545): Promise<{ anvil: ForkHandle; rpcUrl: string }> {
  const anvil = Bun.spawn(
    [
      'anvil',
      '--fork-url',
      FORK_URL,
      '--fork-block-number',
      String(FORK_BLOCK),
      '--chain-id',
      String(base.id),
      '--port',
      String(port)
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  const rpcUrl = `http://127.0.0.1:${port}`
  await waitForRpc(rpcUrl)
  return { anvil, rpcUrl }
}

/**
 * Teardown: SIGKILL the forked node and await its exit so the port is freed before the next suite and
 * nothing dangles past `afterAll`. Awaited by callers.
 */
export async function stopFork(anvil: ForkHandle | undefined): Promise<void> {
  if (!anvil) return
  anvil.kill('SIGKILL')
  await anvil.exited
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
  // Deploy via the canonical CREATE2 factory (present on the Base fork) so the Executor lands at the
  // deterministic address the bot derives — the same mechanism as the production deploy script.
  const { address, factory, factoryData } = Executor.with()
  const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
  await wallet.waitForTransactionReceipt({ hash })
  const code = await wallet.getCode({ address })
  if (!code || code === '0x') throw new Error(`Executor not deployed at ${address}`)
  return address
}
