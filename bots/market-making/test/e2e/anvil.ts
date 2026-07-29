import type { Subprocess } from 'bun'

import { createTestClient, http, publicActions } from 'viem'
import { base } from 'viem/chains'

import { AnvilStartupError } from './anvil-startup.error'

const BASE_FORK_BLOCK = 48_900_000n
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
      'RPC_URL_8453 is required to start the pinned Base fork for market-making e2e tests'
    )
  }
  return forkUrl
}

export type AnvilHandle = {
  client: ReturnType<typeof createAnvilClient>
  process: Subprocess
  rpcUrl: string
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

    await Bun.sleep(STARTUP_POLL_INTERVAL_MS)
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
  await handle.process.exited
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
  const process = Bun.spawn(
    [
      Bun.which('anvil') ?? 'anvil',
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
    { stdout: 'ignore', stderr: 'ignore' }
  )
  const rpcUrl = `http://127.0.0.1:${port}`
  const handle = { client: createAnvilClient(rpcUrl), process, rpcUrl }

  try {
    await waitForAnvil(handle)
    return handle
  } catch (error) {
    await stopAnvil(handle)
    throw error
  }
}
