import type { ChildProcess } from 'node:child_process'

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTestClient, http, publicActions } from 'viem'
import { base } from 'viem/chains'

import { AnvilStartupError } from './anvil-startup.error'

const BASE_FORK_BLOCK = 48_900_000n
// 8546 is this suite's slot in the repo-wide anvil port registry (see the liquidation bots'
// fork harnesses); vitest runs test files in parallel, so the ports must not overlap.
const DEFAULT_ANVIL_PORT = 8546
const STARTUP_POLL_INTERVAL_MS = 100
const STARTUP_TIMEOUT_MS = 10_000

const createAnvilClient = (rpcUrl: string) =>
  createTestClient({
    chain: base,
    mode: 'anvil',
    transport: http(rpcUrl, { retryCount: 0 })
  }).extend(publicActions)

const requireForkUrl = () => {
  const forkUrl = process.env.RPC_URL_8453?.trim()
  if (!forkUrl) {
    throw new AnvilStartupError(
      'RPC_URL_8453 is required to start the pinned Base fork for quoter-bot e2e tests'
    )
  }
  return forkUrl
}

export type AnvilHandle = {
  client: ReturnType<typeof createAnvilClient>
  process: ChildProcess
  rpcUrl: string
  /** Resolves once the child has actually exited. Node has no `.exited`, so it is built at spawn. */
  exited: Promise<void>
}

const waitForAnvil = async (handle: AnvilHandle) => {
  const deadline = performance.now() + STARTUP_TIMEOUT_MS
  let cause: unknown

  while (performance.now() < deadline) {
    if (handle.process.exitCode !== null) {
      throw new AnvilStartupError(
        `Anvil exited before readiness with code ${handle.process.exitCode}`
      )
    }

    try {
      await handle.client.getChainId()
      return
    } catch (error) {
      cause = error
    }

    await sleep(STARTUP_POLL_INTERVAL_MS)
  }

  throw new AnvilStartupError(`Anvil was not ready within ${STARTUP_TIMEOUT_MS}ms`, { cause })
}

/**
 * Terminates an e2e Anvil process and waits until its port is released.
 *
 * @param handle - Running Anvil handle, or `undefined` when setup did not reach process creation.
 * @returns A promise that resolves after the process exits.
 * @remarks Sends `SIGKILL` so failed tests cannot leave an orphaned local node.
 */
export const stopAnvil = async (handle: AnvilHandle | undefined) => {
  if (!handle) return

  if (handle.process.exitCode === null) handle.process.kill('SIGKILL')
  await handle.exited
}

/**
 * Starts an Anvil node forked from a pinned historical Base block.
 *
 * @param port - Loopback port reserved for this suite.
 * @returns The running process, its Viem client, and its local JSON-RPC URL.
 * @throws {@link AnvilStartupError} When the archive RPC is absent, Anvil exits early, or JSON-RPC
 * readiness times out.
 * @remarks Requires `anvil` on `PATH` and an archive-capable `RPC_URL_8453`. The caller must pass
 * the result to {@link stopAnvil}.
 */
export const startAnvil = async (port = DEFAULT_ANVIL_PORT): Promise<AnvilHandle> => {
  const forkUrl = requireForkUrl()
  const child = spawn(
    'anvil',
    [
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      String(BASE_FORK_BLOCK),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      String(base.id),
      '--hardfork',
      'osaka'
    ],
    { stdio: 'ignore' }
  )
  const rpcUrl = `http://127.0.0.1:${port}`
  // Attach the exit listener before anything can await it, so a fast failure is never missed.
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
  })
  const handle = { client: createAnvilClient(rpcUrl), process: child, rpcUrl, exited }

  try {
    await waitForAnvil(handle)
    return handle
  } catch (error) {
    await stopAnvil(handle)
    throw error
  }
}
