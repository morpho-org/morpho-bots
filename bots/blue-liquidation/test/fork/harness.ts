import type { Subprocess } from 'bun'
import type { Address } from 'viem'

import { Executor } from '@repo/contracts'
import { ensureError } from '@repo/utils'
import { createTestClient, createWalletClient, http, parseEther, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { MarketParams } from '../../src/market'

export const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address
export const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address // Base Uniswap SwapRouter02

/**
 * A real, currently-unhealthy Base Morpho Blue position to drive the end-to-end fork test. This must
 * be DISCOVERED and filled in before the suite runs (as the sibling midnight bot did): pick a live
 * position whose health has crossed (or warp forward with `warpBy` to accrue it past the boundary),
 * pin the fork at a block where its oracle + the collateral's Uniswap pool are deterministic, and set
 * `RPC_URL_8453` to a Base archive RPC. Until then the suite skips (never fails `bun test`).
 */
export type ForkFixture = {
  forkBlock: bigint
  marketParams: MarketParams
  borrower: Address
  /** Uniswap-V3 fee tier of a deep collateral→loan pool on Base (e.g. 500 / 3000). */
  poolFee: number
  /** Optional seconds to warp forward to accrue interest and push a borderline position unhealthy. */
  warpBySeconds?: bigint
}

/** The fork RPC, required only to RUN the suite. Absent → the suite skips (see liquidation.test.ts). */
export const FORK_URL: string | undefined = process.env.RPC_URL_8453

// Well-known anvil dev keys (throwaway; funded via setBalance on the fork). #0 is the liquidator EOA
// the bot signs with; #1 deploys the Executor singleton (it has no owner, so the deployer is moot).
export const LIQUIDATOR_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const DEPLOYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const

export const LIQUIDATOR = privateKeyToAccount(LIQUIDATOR_KEY).address

export type TestClient = ReturnType<typeof testClient>
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
 * Boots an anvil instance forking Base at `forkBlock` (chain id pinned to Base so signatures match).
 * `port` is explicit so multiple fork test files can run in one `bun test` process without colliding.
 * Requires the `anvil` binary on PATH (Foundry locally; foundry-toolchain in CI) and `FORK_URL`.
 */
export async function startFork(
  forkBlock: bigint,
  port = 8545
): Promise<{ anvil: ForkHandle; rpcUrl: string }> {
  if (!FORK_URL) throw new Error('RPC_URL_8453 is required to start the fork')
  const anvil = Bun.spawn(
    [
      'anvil',
      '--fork-url',
      FORK_URL,
      '--fork-block-number',
      String(forkBlock),
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

/** Teardown: SIGKILL the forked node and await its exit so the port is freed before the next suite. */
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

/**
 * Warps the chain forward by `seconds` and mines a block, so the next lens read sees accrued interest
 * against the new `block.timestamp` (Blue debt grows with elapsed time — the way a borderline position
 * is pushed deterministically past its health boundary in the fork).
 */
export async function warpBy(test: TestClient, seconds: bigint): Promise<void> {
  const latest = await test.getBlock({ blockTag: 'latest' })
  await test.setNextBlockTimestamp({ timestamp: latest.timestamp + seconds })
  await test.mine({ blocks: 1 })
}

/**
 * Deploys the vendored generic Executor singleton via the canonical CREATE2 factory (present on the
 * Base fork) so it lands at the deterministic address the bot derives — the same mechanism as the
 * production deploy script. Funds the throwaway deployer first.
 */
export async function deployExecutor(test: TestClient, rpcUrl: string): Promise<Address> {
  const account = privateKeyToAccount(DEPLOYER_KEY)
  await test.setBalance({ address: account.address, value: parseEther('100') })
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) }).extend(
    publicActions
  )
  const { address, factory, factoryData } = Executor.with()
  const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
  await wallet.waitForTransactionReceipt({ hash })
  const code = await wallet.getCode({ address })
  if (!code || code === '0x') throw new Error(`Executor not deployed at ${address}`)
  return address
}
