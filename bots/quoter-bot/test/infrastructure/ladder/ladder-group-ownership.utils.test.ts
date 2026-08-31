import type { Address, Hex } from 'viem'

import { readdirSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

const jsonFiles = (directory: string) =>
  readdirSync(directory).filter(name => name.endsWith('.json'))

const maker: Address = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'22'.repeat(32)}`
const lowerGroup: Hex = `0x${'33'.repeat(32)}`
const higherGroup: Hex = `0x${'44'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 20n }]
}

describe('createLadderGroupOwnership', () => {
  test('isolates publications per chain for the same maker', async () => {
    // Regression: the strategy key used to be {strategy, maker} with no chain. One maker running
    // Base and mainnet against a shared XDG_STATE_HOME made each chain read the other's
    // publications as removed markets and cancel their group IDs on the wrong chain.
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-chains-'))
    try {
      const baseOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await baseOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      await baseOwnership.confirm([lowerGroup])

      const mainnetOwnership = createLadderGroupOwnership(
        { chainId: mainnet.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      // Mainnet must not inherit the Base group, or it would cancel it on mainnet.
      expect(await mainnetOwnership.readGroupIds()).toEqual([])

      await mainnetOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0] }]
      })
      await mainnetOwnership.confirm([higherGroup])

      // Each chain still sees exactly its own group after the other has written.
      expect(await mainnetOwnership.readGroupIds()).toEqual([higherGroup])
      expect(await baseOwnership.readGroupIds()).toEqual([lowerGroup])
      expect(jsonFiles(stateDirectory)).toHaveLength(2)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('migrates pre-multi-chain state forward on Base but never on mainnet', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-migrate-'))
    try {
      // State written under the chain-less key that existed before multi-chain support.
      const preMultiChainStrategy = keccak256(
        stringToHex(JSON.stringify({ strategy: 'ladder', maker }))
      )
      await writeFile(
        join(stateDirectory, `${preMultiChainStrategy}.json`),
        JSON.stringify({
          version: 1,
          strategy: preMultiChainStrategy,
          publications: [
            {
              marketId,
              status: 'confirmed',
              quote: {
                marketId,
                centerRateBps: '500',
                groupMode: 'shared-rung',
                lower: [{ index: 0, rateBps: '450', assets: '10' }],
                higher: [{ index: 0, rateBps: '550', assets: '20' }]
              },
              groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
            }
          ]
        }),
        { mode: 0o600 }
      )

      // Only Base could be configured when that key was in use, so Base adopts it...
      const baseOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      expect(await baseOwnership.readGroupIds()).toEqual([lowerGroup])

      // ...and mainnet must not, or it would import Base publications as its own.
      const mainnetOwnership = createLadderGroupOwnership(
        { chainId: mainnet.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      expect(await mainnetOwnership.readGroupIds()).toEqual([])
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('keeps ownership stable when configured ladder markets change', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-'))
    try {
      const ownership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [
          { groupId: lowerGroup, side: 'lower', rungIndexes: [0] },
          { groupId: higherGroup, side: 'higher', rungIndexes: [0] }
        ]
      })

      expect(await ownership.readGroupIds()).toEqual([lowerGroup, higherGroup])
      expect(await ownership.read()).toMatchObject([{ marketId, status: 'reserved', quote }])

      await ownership.confirm([lowerGroup, higherGroup])
      expect(await ownership.read()).toMatchObject([{ status: 'confirmed' }])

      const ownershipAfterUnrelatedAllowlistEdit = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, `0x${'55'.repeat(32)}`] },
        { stateDirectory }
      )
      expect(await ownershipAfterUnrelatedAllowlistEdit.readGroupIds()).toEqual([
        lowerGroup,
        higherGroup
      ])

      await ownership.forget([lowerGroup])
      expect(await ownership.readGroupIds()).toEqual([higherGroup])
      await ownership.forget([higherGroup])
      expect(await ownership.read()).toEqual([])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('discovers legacy ownership after the configured market list changes', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-changed-migration-'))
    const addedMarketId: Hex = `0x${'55'.repeat(32)}`
    try {
      const oldOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new TypeError('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const state = JSON.parse(await readFile(stablePath, 'utf8')) as Record<string, unknown>
      const oldLegacyStrategy = keccak256(
        stringToHex(JSON.stringify({ strategy: 'ladder', maker, marketIds: [marketId] }))
      )
      await rm(stablePath)
      await writeFile(
        join(stateDirectory, `${oldLegacyStrategy}.json`),
        JSON.stringify({ ...state, strategy: oldLegacyStrategy }),
        { mode: 0o600 }
      )

      const changedOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, addedMarketId] },
        { stateDirectory }
      )
      expect(await changedOwnership.readGroupIds()).toEqual([lowerGroup])
      await changedOwnership.migrate()
      expect(jsonFiles(stateDirectory)).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('migrates legacy ownership when an unpublished market changes', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-unpublished-migration-'))
    const unpublishedMarketId: Hex = `0x${'66'.repeat(32)}`
    const replacementMarketId: Hex = `0x${'77'.repeat(32)}`
    try {
      const oldOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, unpublishedMarketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new TypeError('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const state = JSON.parse(await readFile(stablePath, 'utf8')) as Record<string, unknown>
      const oldLegacyStrategy = keccak256(
        stringToHex(
          JSON.stringify({
            strategy: 'ladder',
            maker,
            marketIds: [marketId, unpublishedMarketId].toSorted()
          })
        )
      )
      await rm(stablePath)
      await writeFile(
        join(stateDirectory, `${oldLegacyStrategy}.json`),
        JSON.stringify({ ...state, strategy: oldLegacyStrategy }),
        { mode: 0o600 }
      )

      const changedOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, replacementMarketId] },
        { stateDirectory }
      )
      await changedOwnership.migrate(async () => [lowerGroup])
      expect(await changedOwnership.readGroupIds()).toEqual([lowerGroup])
      expect(jsonFiles(stateDirectory)).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('rejects unverified legacy ownership after an unpublished market changes', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-zero-index-'))
    const unpublishedMarketId: Hex = `0x${'66'.repeat(32)}`
    const replacementMarketId: Hex = `0x${'77'.repeat(32)}`
    try {
      const oldOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, unpublishedMarketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [
          { groupId: lowerGroup, side: 'lower', rungIndexes: [0] },
          { groupId: higherGroup, side: 'higher', rungIndexes: [0] }
        ]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new TypeError('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const state = JSON.parse(await readFile(stablePath, 'utf8')) as Record<string, unknown>
      const oldLegacyStrategy = keccak256(
        stringToHex(
          JSON.stringify({
            strategy: 'ladder',
            maker,
            marketIds: [marketId, unpublishedMarketId].toSorted()
          })
        )
      )
      await rm(stablePath)
      await writeFile(
        join(stateDirectory, `${oldLegacyStrategy}.json`),
        JSON.stringify({ ...state, strategy: oldLegacyStrategy }),
        { mode: 0o600 }
      )

      const changedOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, replacementMarketId] },
        { stateDirectory }
      )
      await changedOwnership.migrate(async () => [])

      expect(await changedOwnership.readGroupIds()).toEqual([])
      expect(jsonFiles(stateDirectory)).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('migrates every group from an attributable legacy publication when only one is indexed', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-partial-index-'))
    const unpublishedMarketId: Hex = `0x${'66'.repeat(32)}`
    const replacementMarketId: Hex = `0x${'77'.repeat(32)}`
    try {
      const oldOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, unpublishedMarketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [
          { groupId: lowerGroup, side: 'lower', rungIndexes: [0] },
          { groupId: higherGroup, side: 'higher', rungIndexes: [0] }
        ]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new TypeError('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const state = JSON.parse(await readFile(stablePath, 'utf8')) as Record<string, unknown>
      const oldLegacyStrategy = keccak256(
        stringToHex(
          JSON.stringify({
            strategy: 'ladder',
            maker,
            marketIds: [marketId, unpublishedMarketId].toSorted()
          })
        )
      )
      await rm(stablePath)
      await writeFile(
        join(stateDirectory, `${oldLegacyStrategy}.json`),
        JSON.stringify({ ...state, strategy: oldLegacyStrategy }),
        { mode: 0o600 }
      )

      const changedOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId, replacementMarketId] },
        { stateDirectory }
      )
      await changedOwnership.migrate(async () => [lowerGroup])

      expect(await changedOwnership.readGroupIds()).toEqual([lowerGroup, higherGroup])
      expect(jsonFiles(stateDirectory)).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('reads legacy ownership without mutation and migrates it explicitly for writers', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-migration-'))
    try {
      const ownership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new TypeError('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const state = JSON.parse(await readFile(stablePath, 'utf8')) as Record<string, unknown>
      const legacyStrategy = keccak256(
        stringToHex(JSON.stringify({ strategy: 'ladder', maker, marketIds: [marketId] }))
      )
      await rm(stablePath)
      await writeFile(
        join(stateDirectory, `${legacyStrategy}.json`),
        JSON.stringify({ ...state, strategy: legacyStrategy }),
        { mode: 0o600 }
      )

      expect(await ownership.readGroupIds()).toEqual([lowerGroup])
      expect(jsonFiles(stateDirectory)).toEqual([`${legacyStrategy}.json`])
      await ownership.migrate()
      expect(jsonFiles(stateDirectory)).toEqual([stableName])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test("does not adopt another maker's overlapping stable ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-foreign-maker-'))
    const foreignMaker: Address = '0x9999999999999999999999999999999999999999'
    try {
      const foreignOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker: foreignMaker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await foreignOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [foreignName] = jsonFiles(stateDirectory)
      if (!foreignName) throw new TypeError('Expected foreign ownership state')

      const ownership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )

      expect(await ownership.read()).toEqual([])
      await ownership.migrate(async () => [])
      expect(await ownership.read()).toEqual([])
      expect(jsonFiles(stateDirectory)).toEqual([foreignName])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('rejects an ownership file with group-readable permissions', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-security-'))
    try {
      const ownership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0] }]
      })
      const [path] = jsonFiles(stateDirectory)
      if (!path) throw new Error('Expected ownership state')
      await chmod(join(stateDirectory, path), 0o644)
      await expect(ownership.read()).rejects.toMatchObject({
        name: 'LadderAdapterError',
        operation: 'group-ownership-state'
      })
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('does not commit a write when legacy ownership cleanup validation fails', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-write-validation-'))
    try {
      const ownership = createLadderGroupOwnership(
        { chainId: base.id, maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = jsonFiles(stateDirectory)
      if (!stableName) throw new Error('Expected stable ownership state')
      const stablePath = join(stateDirectory, stableName)
      const stateBeforeWrite = await readFile(stablePath, 'utf8')
      const malformedLegacyPath = join(stateDirectory, `0x${'99'.repeat(32)}.json`)
      await writeFile(malformedLegacyPath, '{}', { mode: 0o644 })

      await expect(
        ownership.reserve({
          marketId,
          quote,
          groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0] }]
        })
      ).rejects.toMatchObject({
        name: 'LadderAdapterError',
        operation: 'group-ownership-state'
      })
      expect(await readFile(stablePath, 'utf8')).toBe(stateBeforeWrite)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
