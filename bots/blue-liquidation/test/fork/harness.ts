import type { ChildProcess } from 'node:child_process'
import type { Address } from 'viem'

import { Executor } from '@repo/contracts'
import { ensureError } from '@repo/utils'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseEther,
  publicActions
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { MarketParams } from '../../src/market'

export const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address
export const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address // Base Uniswap SwapRouter02

/**
 * A real, currently-unhealthy Base Morpho Blue position to drive the end-to-end fork test. Pick a
 * live position whose health has crossed (or warp forward with `warpBy`), pin a deterministic fork
 * block, and set `RPC_URL_8453` to a Base archive RPC. Until then the suite skips.
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

type RawForkFixture = {
  forkBlock?: unknown
  marketParams?: {
    loanToken?: unknown
    collateralToken?: unknown
    oracle?: unknown
    irm?: unknown
    lltv?: unknown
  }
  borrower?: unknown
  poolFee?: unknown
  warpBySeconds?: unknown
}

function parseUint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new Error(`${field} must be a non-negative integer string`)
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value === 'string' && isAddress(value, { strict: false })) return getAddress(value)
  throw new Error(`${field} must be an address`)
}

function parsePoolFee(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  throw new Error('poolFee must be a positive integer')
}

function parseForkFixture(raw: unknown): ForkFixture {
  if (typeof raw !== 'object' || raw === null) throw new Error('fixture must be a JSON object')
  const fixture = raw as RawForkFixture
  const marketParams = fixture.marketParams
  if (typeof marketParams !== 'object' || marketParams === null) {
    throw new Error('marketParams must be a JSON object')
  }
  return {
    forkBlock: parseUint(fixture.forkBlock, 'forkBlock'),
    marketParams: {
      loanToken: parseAddress(marketParams.loanToken, 'marketParams.loanToken'),
      collateralToken: parseAddress(marketParams.collateralToken, 'marketParams.collateralToken'),
      oracle: parseAddress(marketParams.oracle, 'marketParams.oracle'),
      irm: parseAddress(marketParams.irm, 'marketParams.irm'),
      lltv: parseUint(marketParams.lltv, 'marketParams.lltv')
    },
    borrower: parseAddress(fixture.borrower, 'borrower'),
    poolFee: parsePoolFee(fixture.poolFee),
    ...(fixture.warpBySeconds === undefined
      ? {}
      : { warpBySeconds: parseUint(fixture.warpBySeconds, 'warpBySeconds') })
  }
}

/**
 * Reads a fork fixture from `BLUE_LIQUIDATION_FORK_FIXTURE`, when provided. Integer fields should be
 * decimal strings so the fixture round-trips through JSON without precision loss.
 */
export function loadForkFixtureFromEnv(env = process.env): ForkFixture | null {
  const raw = env.BLUE_LIQUIDATION_FORK_FIXTURE?.trim()
  if (!raw) return null
  try {
    return parseForkFixture(JSON.parse(raw))
  } catch (error) {
    throw new Error(`Invalid BLUE_LIQUIDATION_FORK_FIXTURE: ${ensureError(error).message}`, {
      cause: error
    })
  }
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
 * Boots an anvil instance forking Base at `forkBlock` (chain id pinned to Base so signatures match).
 * `port` is explicit so parallel fork test files never collide — see the registry above.
 * Requires the `anvil` binary on PATH (Foundry locally; foundry-toolchain in CI) and `FORK_URL`.
 */
export async function startFork(
  forkBlock: bigint,
  port = 8545
): Promise<{ anvil: ForkHandle; rpcUrl: string }> {
  if (!FORK_URL) throw new Error('RPC_URL_8453 is required to start the fork')
  const anvil = toForkHandle(
    spawn(
      'anvil',
      [
        '--fork-url',
        FORK_URL,
        '--fork-block-number',
        String(forkBlock),
        '--chain-id',
        String(base.id),
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
