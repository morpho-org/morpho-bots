import type { ChildProcess } from 'node:child_process'
import type { Address, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { ensureError } from '@repo/utils'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTestClient, createWalletClient, http, parseEther, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// The 0xAdedD8ab… deployment is fresh, so it has no organic debt positions to pin. Instead the suite
// MINTS its own liquidatable WETH/USDC position inside the fork via `seedLiquidatablePosition`
// (test/fork/seed.ts): it clones a real curator-trusted WETH/USDC oracle + params, opens a healthy
// position through the real `take` order-book path (exercising the new 336b924a offer typehashes
// end-to-end), then the suite warps past `maturity` to make it post-maturity liquidatable. FORK_BLOCK
// is a fixed block shortly after the deploy so the WETH oracle price and the WETH/USDC pool are
// deterministic; RPC_URL_8453 must be an archive endpoint that serves it (CI secret; locally set it in
// .env.test.local — loaded explicitly by vitest.config.ts via vite's loadEnv).
const FORK_BLOCK = 48_300_000n
export const MIDNIGHT = '0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A' as Address

// Base token + Uniswap-V3 venue addresses for the seeded market.
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address // loan token
export const WETH = '0x4200000000000000000000000000000000000006' as Address // collateral token
export const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address
export const POOL_FEE = 500

// Seeding inputs for `seedLiquidatablePosition` (test/fork/seed.ts). The oracle + lltv + cursor are a
// real curator-trusted WETH/USDC market cloned from the Midnight API; the cursor is not yet enabled on
// the fresh deploy, so the seeder enables it by impersonating the configurator on the fork.
export const WETH_USDC_ORACLE = '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4' as Address
export const LLTV = 860000000000000000n // 0.86 WAD (enabled on-chain)
export const LIQUIDATION_CURSOR = 250000000000000000n // 0.25 WAD (enabled by the seeder via configurator)
export const CONFIGURATOR = '0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa' as Address
export const ECRECOVER_RATIFIER = '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E' as Address

// Throwaway anvil dev keys #2 (maker/lender, buys units + pays USDC) and #3 (borrower/taker, supplies
// WETH collateral + takes on the debt). Funded via setBalance/wrap/swap on the fork.
export const MAKER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdd4d1a1' as Hex
export const BORROWER_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex

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
// run). A bare child_process spawn gives us SIGKILL + an exit promise, which terminate deterministically.
export type ForkHandle = {
  kill: (signal: NodeJS.Signals) => void
  /** Resolves with the exit code once the child has actually gone (Node has no `.exited`). */
  exited: Promise<number | null>
}

// Wraps a ChildProcess in the tiny surface the teardown needs. The `exited` promise is built here,
// at spawn time, so its `exit` listener is attached before the child can possibly exit.
const toForkHandle = (child: ChildProcess): ForkHandle => ({
  kill: signal => {
    child.kill(signal)
  },
  exited: new Promise(resolve => {
    child.once('exit', code => resolve(code))
  })
})

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
    await sleep(100)
  }
  const detail = lastError ? `: ${lastError.message}` : ''
  throw new Error(`anvil RPC at ${url} not ready within ${timeoutMs}ms${detail}`)
}

// Anvil port registry — vitest runs test FILES IN PARALLEL (bun's runner was serial, so fixed ports
// used to be safe within a bot only). Every fork suite in the repo must claim a distinct port:
//   8545 bots/blue-liquidation      fork/liquidation
//   8546 bots/quoter-bot         e2e/setup-check
//   8547 bots/midnight-liquidation  fork/liquidation
//   8548 bots/midnight-liquidation  fork/queue
/**
 * Boots an anvil instance forking Base at FORK_BLOCK (chain id pinned to Base so signatures match).
 * `port` is explicit so parallel fork test files never collide — see the registry above.
 * Requires the `anvil` binary on PATH (Foundry locally; foundry-toolchain in CI).
 */
export async function startFork(port = 8545): Promise<{ anvil: ForkHandle; rpcUrl: string }> {
  const anvil = toForkHandle(
    spawn(
      'anvil',
      [
        '--fork-url',
        FORK_URL,
        '--fork-block-number',
        String(FORK_BLOCK),
        '--chain-id',
        String(base.id),
        // The deployed Midnight is compiled for the `osaka` EVM and uses the CLZ opcode (EIP-7939) in
        // liquidate; anvil's default hardfork lacks CLZ, so it would revert with empty data. Pin osaka.
        '--hardfork',
        'osaka',
        '--port',
        String(port)
      ],
      { stdio: 'ignore' }
    )
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
 * Ensures the vendored generic Executor singleton exists at its deterministic CREATE2 address on the
 * fork and returns it (the bot's EXECUTOOOR_ADDRESS). Idempotent: since the Executor is a real
 * singleton already deployed on Base, at a recent FORK_BLOCK it is already present, so we skip the
 * deploy (redeploying to the same CREATE2 address reverts). Only forks pinned before its mainnet
 * deployment need the deploy path.
 */
export async function deployExecutor(test: TestClient, rpcUrl: string): Promise<Address> {
  const account = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) }).extend(
    publicActions
  )
  // Deploy via the canonical CREATE2 factory (present on the Base fork) so the Executor lands at the
  // deterministic address the bot derives — the same mechanism as the production deploy script.
  const { address, factory, factoryData } = Executor.with()
  const existing = await wallet.getCode({ address })
  if (existing && existing !== '0x') return address
  await test.setBalance({ address: account.address, value: parseEther('100') })
  const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
  await wallet.waitForTransactionReceipt({ hash })
  const code = await wallet.getCode({ address })
  if (!code || code === '0x') throw new Error(`Executor not deployed at ${address}`)
  return address
}
