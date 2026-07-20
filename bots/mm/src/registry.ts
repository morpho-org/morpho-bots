import type { Address, Hash } from 'viem'

export type LogicalGroupEntry = {
  chainId: number
  maker: Address
  protocolGroups: readonly [Hash, Hash]
  artifact: string
  createdAt: string
  cancelArtifacts?: readonly string[]
}

export type Registry = Record<string, LogicalGroupEntry>

export function addLogicalGroup(
  registry: Registry,
  logicalGroupId: string,
  entry: LogicalGroupEntry
) {
  if (registry[logicalGroupId]) {
    throw new Error(
      `Logical group "${logicalGroupId}" already exists; cancel it or choose another id`
    )
  }
  return { ...registry, [logicalGroupId]: entry }
}

export function getLogicalGroup(registry: Registry, logicalGroupId: string) {
  const entry = registry[logicalGroupId]
  if (!entry) throw new Error(`Unknown logical group "${logicalGroupId}"`)
  return entry
}
