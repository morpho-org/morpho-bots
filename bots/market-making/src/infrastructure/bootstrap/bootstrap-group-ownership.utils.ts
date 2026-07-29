import type { Address, Hex } from 'viem'

import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, isHex, keccak256, size, stringToHex } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapGroupOwnershipConfig = {
  maker: Address
  marketIds: readonly Hex[]
  configuredGroupIds: readonly Hex[]
}

type BootstrapGroupOwnershipDependencies = {
  stateDirectory?: string
}

type OwnershipState = {
  version: 1
  strategy: string
  groupIds: string[]
}

const canonicalId = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return bytesToHex(hexToBytes(value))
}

const strategyId = (config: BootstrapGroupOwnershipConfig) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        maker: config.maker,
        marketIds: config.marketIds.map(canonicalId).toSorted()
      })
    )
  )

/**
 * Creates the durable explicit ownership source shared by setup readiness, position reads, and writes.
 * @param config - Maker, configured markets, and operator-configured group IDs defining one strategy.
 * @param dependencies - Optional state directory override used by isolated tests.
 * @returns A source that reads explicit IDs and atomically remembers confirmed bot-issued IDs.
 * @throws `BootstrapAdapterError` when persisted ownership state is malformed or insecurely permissioned.
 * @remarks State is namespaced by maker and configured markets, stored mode `0600`, and never infers ownership from market membership.
 */
export const createBootstrapGroupOwnership = (
  config: BootstrapGroupOwnershipConfig,
  dependencies: BootstrapGroupOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const directory =
    dependencies.stateDirectory ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-market-making')
  const path = join(directory, `${strategy}.json`)
  const configured = config.configuredGroupIds.map(canonicalId)

  const readPersisted = async (): Promise<Hex[]> => {
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new BootstrapAdapterError('group-ownership-state')
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new BootstrapAdapterError('group-ownership-state')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new BootstrapAdapterError('group-ownership-state')
    }
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<OwnershipState>
      if (value.version !== 1 || value.strategy !== strategy || !Array.isArray(value.groupIds)) {
        throw new BootstrapAdapterError('group-ownership-state')
      }
      return value.groupIds.map(canonicalId)
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('group-ownership-state')
    }
  }

  const read = async () => [...new Set([...configured, ...(await readPersisted())])]

  return {
    /** Reads configured and safely persisted strategy-owned group IDs. @returns Canonical explicit ownership IDs. */
    read,
    /** Atomically records one confirmed bot-issued group for later invocations. @param groupId - Confirmed published group ID. @returns Completion after durable replacement. */
    remember: async (groupId: Hex) => {
      const groupIds = [...new Set([...(await read()), canonicalId(groupId)])]
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, strategy, groupIds }), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    }
  }
}
