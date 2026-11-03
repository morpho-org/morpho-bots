import type { ChildProcess } from 'node:child_process'
import type { Address, Hex } from 'viem'

import { Executor, MorphoAbi } from '@repo/contracts'
import { createDeploylessClient } from '@repo/kit'
import { ensureError, lensKey, mulDivDown } from '@repo/utils'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  concat,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  publicActions,
  toHex
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { MarketParams } from '../../src/market'

import { marketId } from '../../src/market'
import { readBlueLiquidationLens } from '../../src/state/lens.sol'

export const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address
export const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address // Base Uniswap SwapRouter02
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

// Shared with midnight's fork suite, so CI's fork cache serves both.
const FORK_BLOCK = 48_300_000n

/** Base's largest WETH/USDC Blue Market (id 0x8793cf30…). */
export const MARKET: MarketParams = {
  loanToken: USDC,
  collateralToken: WETH,
  oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  lltv: 860_000_000_000_000_000n
}
/** The Uniswap V3 WETH/USDC pool tier the seized collateral sells through. */
export const POOL_FEE = 500

const COLLATERAL = parseEther('1')
/** How close to the LLTV the seeded position borrows. */
const BORROW_BPS = 9_500n
/** The oracle price the position is made unhealthy at, against the real one. */
const PRICE_DROP_BPS = 9_000n
const BPS = 10_000n
const ORACLE_PRICE_SCALE = 10n ** 36n
const WAD = 10n ** 18n

/** The fork RPC, required only to RUN the suite. Absent → the suite skips (see liquidation.test.ts). */
export const FORK_URL: string | undefined = process.env.RPC_URL_8453

/**
 * A fresh key, since the kernel refuses an account with code and anvil's published dev keys carry
 * an EIP-7702 delegation on Base.
 */
export const LIQUIDATOR_KEY = generatePrivateKey()
// Anvil dev key #1 deploys the Executor singleton; it has no owner, so the deployer is moot.
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

// Anvil port registry — vitest runs test FILES IN PARALLEL, so every fork suite in the repo must
// claim a distinct port:
//   8545 bots/blue-liquidation      fork/liquidation
//   8546 bots/quoter-bot         e2e/setup-check
//   8547 bots/midnight-liquidation  fork/liquidation
//   8548 bots/midnight-liquidation  fork/queue
//   8549 bots/quoter-bot            e2e/quoter-bot
//   8551 packages/kit               kernel.anvil (local chain, no fork)
//   8552 framework/kernel           host.anvil (local chain, no fork)
//   8551 packages/bot-kit           kernel.anvil (local chain, no fork)
/**
 * Boots an anvil instance forking Base at {@link FORK_BLOCK} (chain id pinned to Base so signatures match).
 * `port` is explicit so parallel fork test files never collide — see the registry above.
 * Requires the `anvil` binary on PATH (Foundry locally; foundry-toolchain in CI) and `FORK_URL`.
 */
export async function startFork(port = 8545): Promise<{ anvil: ForkHandle; rpcUrl: string }> {
  if (!FORK_URL) throw new Error('RPC_URL_8453 is required to start the fork')
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

/** anvil writes its fork cache (`~/.foundry/cache/rpc`) only when it shuts down gracefully. */
const CACHE_FLUSH_GRACE_MS = 5_000

/** Resolves once anvil has exited and freed its port, killing it after {@link CACHE_FLUSH_GRACE_MS}. */
export async function stopFork(anvil: ForkHandle | undefined): Promise<void> {
  if (!anvil) return
  const fallback = setTimeout(() => anvil.kill('SIGKILL'), CACHE_FLUSH_GRACE_MS)
  anvil.kill('SIGTERM')
  await anvil.exited
  clearTimeout(fallback)
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
 * Deploys the vendored generic Executor singleton via the canonical CREATE2 factory (present on the
 * Base fork) so it lands at the deterministic address the bot derives — the same mechanism as the
 * production deploy script. Returns early when the fork already holds it.
 */
export async function deployExecutor(test: TestClient, rpcUrl: string): Promise<Address> {
  const account = privateKeyToAccount(DEPLOYER_KEY)
  await test.setBalance({ address: account.address, value: parseEther('100') })
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) }).extend(
    publicActions
  )
  const { address, factory, factoryData } = Executor.with()
  const existing = await wallet.getCode({ address })
  if (existing && existing !== '0x') return address
  const hash = await wallet.sendTransaction({ to: factory, data: factoryData })
  await wallet.waitForTransactionReceipt({ hash })
  const code = await wallet.getCode({ address })
  if (!code || code === '0x') throw new Error(`Executor not deployed at ${address}`)
  return address
}

/** The bytecode of a contract that returns `price` for any call. */
const constantPriceOracle = (price: bigint): Hex =>
  concat(['0x7f', toHex(price, { size: 32 }), '0x60005260206000f3'])

/**
 * Opens a {@link MARKET} position for a fresh borrower at {@link BORROW_BPS} of its LLTV, then makes
 * it unhealthy by replacing the market's oracle with one quoting {@link PRICE_DROP_BPS} of the real
 * price. Blue and the lens read only the oracle's `price()`, so the stand-in changes nothing else.
 */
export async function seedUnhealthyPosition(test: TestClient, rpcUrl: string): Promise<Address> {
  const account = privateKeyToAccount(generatePrivateKey())
  await fundEth(test, account.address)
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) })
  const send = async (write: Promise<Hex>, step: string) => {
    const receipt = await test.waitForTransactionReceipt({ hash: await write })
    if (receipt.status !== 'success') throw new Error(`seeding reverted at ${step}`)
  }
  await send(wallet.sendTransaction({ to: WETH, value: COLLATERAL }), 'wrap')
  await send(
    wallet.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'approve',
      args: [MORPHO, COLLATERAL]
    }),
    'approve'
  )
  await send(
    wallet.writeContract({
      address: MORPHO,
      abi: MorphoAbi,
      functionName: 'supplyCollateral',
      args: [MARKET, COLLATERAL, account.address, '0x']
    }),
    'supplyCollateral'
  )
  const lens = await readBlueLiquidationLens(
    createDeploylessClient({ chain: base, rpcUrl }),
    MORPHO,
    [{ params: MARKET, borrower: account.address }]
  )
  const reading = lens.get(lensKey(marketId(MARKET), account.address))
  if (!reading?.valid) throw new Error('the lens did not read the seeded market')
  const price = reading.collateralPrice
  const maxBorrow = mulDivDown(mulDivDown(COLLATERAL, price, ORACLE_PRICE_SCALE), MARKET.lltv, WAD)
  await send(
    wallet.writeContract({
      address: MORPHO,
      abi: MorphoAbi,
      functionName: 'borrow',
      args: [MARKET, mulDivDown(maxBorrow, BORROW_BPS, BPS), 0n, account.address, account.address]
    }),
    'borrow'
  )
  await test.setCode({
    address: MARKET.oracle,
    bytecode: constantPriceOracle(mulDivDown(price, PRICE_DROP_BPS, BPS))
  })
  await test.mine({ blocks: 1 })
  return account.address
}
