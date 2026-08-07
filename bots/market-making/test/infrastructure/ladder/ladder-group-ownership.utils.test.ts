import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

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
  test('keeps ownership stable when configured ladder markets change', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-'))
    try {
      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
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
        { maker, strategyMarketIds: [marketId, `0x${'55'.repeat(32)}`] },
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
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
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
        { maker, strategyMarketIds: [marketId, addedMarketId] },
        { stateDirectory }
      )
      expect(await changedOwnership.readGroupIds()).toEqual([lowerGroup])
      await changedOwnership.migrate()
      expect(Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('leaves ambiguous legacy ownership untouched when an unpublished market changes', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-unpublished-migration-'))
    const unpublishedMarketId: Hex = `0x${'66'.repeat(32)}`
    const replacementMarketId: Hex = `0x${'77'.repeat(32)}`
    try {
      const oldOwnership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId, unpublishedMarketId] },
        { stateDirectory }
      )
      await oldOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
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
        { maker, strategyMarketIds: [marketId, replacementMarketId] },
        { stateDirectory }
      )
      expect(await changedOwnership.readGroupIds()).toEqual([])
      await changedOwnership.migrate()
      expect(Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))).toHaveLength(1)
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('reads legacy ownership without mutation and migrates it explicitly for writers', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-migration-'))
    try {
      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [stableName] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
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
      expect(Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))).toEqual([
        `${legacyStrategy}.json`
      ])
      await ownership.migrate()
      expect(Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))).toEqual([stableName])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test("does not adopt another maker's overlapping stable ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-foreign-maker-'))
    const foreignMaker: Address = '0x9999999999999999999999999999999999999999'
    try {
      const foreignOwnership = createLadderGroupOwnership(
        { maker: foreignMaker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await foreignOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0] }]
      })
      const [foreignName] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
      if (!foreignName) throw new TypeError('Expected foreign ownership state')

      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )

      expect(await ownership.read()).toEqual([])
      await ownership.migrate()
      expect(Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))).toEqual([foreignName])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('rejects an ownership file with group-readable permissions', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-security-'))
    try {
      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0] }]
      })
      const [path] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
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
})
