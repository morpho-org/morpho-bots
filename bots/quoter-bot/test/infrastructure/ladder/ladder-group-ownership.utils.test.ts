import type { Address, Hex } from 'viem'

import { MAX_TICK } from '@morpho-org/midnight-sdk'
import { readdirSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder'

import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'
import { STRATEGY_STATE_VERSION } from '../../../src/infrastructure/strategy-state/strategy-state-file.utils'
import { StrategyStateVersionError } from '../../../src/infrastructure/strategy-state/strategy-state-version.error'

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
        { chainId: base.id, maker },
        { stateDirectory }
      )
      await baseOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }]
      })
      await baseOwnership.confirm([lowerGroup])

      const mainnetOwnership = createLadderGroupOwnership(
        { chainId: mainnet.id, maker },
        { stateDirectory }
      )
      // Mainnet must not inherit the Base group, or it would cancel it on mainnet.
      expect(await mainnetOwnership.readGroupIds()).toEqual([])

      await mainnetOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ticks: [100n] }]
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

  test("does not adopt another maker's overlapping stable ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-foreign-maker-'))
    const foreignMaker: Address = '0x9999999999999999999999999999999999999999'
    try {
      const foreignOwnership = createLadderGroupOwnership(
        { chainId: base.id, maker: foreignMaker },
        { stateDirectory }
      )
      await foreignOwnership.reserve({
        marketId,
        quote,
        groups: [{ groupId: lowerGroup, side: 'lower', rungIndexes: [0], ticks: [100n] }]
      })
      const [foreignName] = jsonFiles(stateDirectory)
      if (!foreignName) throw new TypeError('Expected foreign ownership state')

      const ownership = createLadderGroupOwnership({ chainId: base.id, maker }, { stateDirectory })

      expect(await ownership.read()).toEqual([])
      expect(jsonFiles(stateDirectory)).toEqual([foreignName])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })

  test('rejects an ownership file with group-readable permissions', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-security-'))
    try {
      const ownership = createLadderGroupOwnership({ chainId: base.id, maker }, { stateDirectory })
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ticks: [100n] }]
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

  describe('higherSkewBps', () => {
    const strategy = keccak256(
      stringToHex(JSON.stringify({ strategy: 'ladder', chainId: base.id, maker }))
    )
    const withStoredQuote = async (
      storedQuote: Record<string, unknown>,
      check: (ownership: ReturnType<typeof createLadderGroupOwnership>) => Promise<void>
    ) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-skew-'))
      try {
        await writeFile(
          join(stateDirectory, `${strategy}.json`),
          JSON.stringify({
            version: STRATEGY_STATE_VERSION,
            strategy,
            publications: [
              {
                marketId,
                status: 'confirmed',
                quote: storedQuote,
                groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ticks: ['100'] }]
              }
            ]
          }),
          { mode: 0o600 }
        )
        await check(createLadderGroupOwnership({ chainId: base.id, maker }, { stateDirectory }))
      } finally {
        await rm(stateDirectory, { recursive: true, force: true })
      }
    }
    const storedQuote = {
      marketId,
      centerRateBps: '500',
      groupMode: 'shared-rung',
      lower: [{ index: 0, rateBps: '450', units: '10' }],
      higher: [{ index: 0, rateBps: '550', units: '20' }]
    }

    test('round-trips the skew a publication was planned at', async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-skew-'))
      try {
        const ownership = createLadderGroupOwnership(
          { chainId: base.id, maker },
          { stateDirectory }
        )
        await ownership.reserve({
          marketId,
          quote: { ...quote, higherSkewBps: 25n },
          groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ticks: [100n] }]
        })

        expect((await ownership.read())[0]?.quote).toEqual({ ...quote, higherSkewBps: 25n })
        const [file] = jsonFiles(stateDirectory)
        const stored = JSON.parse(await readFile(join(stateDirectory, file!), 'utf8'))
        expect(stored.publications[0].quote.higherSkewBps).toBe('25')
      } finally {
        await rm(stateDirectory, { recursive: true, force: true })
      }
    })

    test('reads a record without the field as unskewed', async () => {
      await withStoredQuote(storedQuote, async ownership => {
        const [publication] = await ownership.read()
        expect(publication?.quote).toStrictEqual(quote)
        expect(publication?.quote.higherSkewBps ?? 0n).toBe(0n)
      })
    })

    test('tolerates an unknown quote field beside the skew', async () => {
      await withStoredQuote(
        { ...storedQuote, higherSkewBps: '7', futureField: 'x' },
        async ownership => {
          expect((await ownership.read())[0]?.quote).toEqual({ ...quote, higherSkewBps: 7n })
        }
      )
    })

    test.each(['-1', '1.5', 7])('rejects a malformed skew %o', async higherSkewBps => {
      await withStoredQuote({ ...storedQuote, higherSkewBps }, async ownership => {
        await expect(ownership.read()).rejects.toMatchObject({
          name: 'LadderAdapterError',
          operation: 'group-ownership-state'
        })
      })
    })
  })

  describe('group ticks', () => {
    const strategy = keccak256(
      stringToHex(JSON.stringify({ strategy: 'ladder', chainId: base.id, maker }))
    )
    const storedQuote = {
      marketId,
      centerRateBps: '500',
      groupMode: 'shared-rung',
      lower: [{ index: 0, rateBps: '450', units: '10' }],
      higher: [{ index: 0, rateBps: '550', units: '20' }]
    }

    test('round-trips the exact tick of every offer in a group', async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-ticks-'))
      try {
        const config = { chainId: base.id, maker }
        const groups = [
          { groupId: higherGroup, side: 'higher' as const, rungIndexes: [0, 1], ticks: [0n, 7n] }
        ]
        await createLadderGroupOwnership(config, { stateDirectory }).reserve({
          marketId,
          quote: { ...quote, groupMode: 'per-book' },
          groups
        })
        const [file] = jsonFiles(stateDirectory)
        const stored = JSON.parse(await readFile(join(stateDirectory, file!), 'utf8'))

        expect(stored.publications[0].groups[0].ticks).toEqual(['0', '7'])
        expect(
          (await createLadderGroupOwnership(config, { stateDirectory }).read())[0]?.groups
        ).toEqual(groups)
      } finally {
        await rm(stateDirectory, { recursive: true, force: true })
      }
    })

    test.each([
      ['missing', {}],
      ['empty', { ticks: [] }],
      ['negative', { ticks: ['-1'] }],
      ['numeric', { ticks: [7] }],
      ['non-canonical', { ticks: ['07'] }],
      ['above MAX_TICK', { ticks: [String(MAX_TICK + 1n)] }],
      ['duplicated', { ticks: ['7', '7'] }],
      ['multi-tick shared-rung', { ticks: ['7', '8'] }]
    ])('fails loud on a %s ticks field', async (_name, ticks) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-ticks-'))
      try {
        await writeFile(
          join(stateDirectory, `${strategy}.json`),
          JSON.stringify({
            version: STRATEGY_STATE_VERSION,
            strategy,
            publications: [
              {
                marketId,
                status: 'confirmed',
                quote: storedQuote,
                groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ...ticks }]
              }
            ]
          }),
          { mode: 0o600 }
        )
        const ownership = createLadderGroupOwnership(
          { chainId: base.id, maker },
          { stateDirectory }
        )

        await expect(ownership.read()).rejects.toMatchObject({
          name: 'LadderAdapterError',
          operation: 'group-ownership-state'
        })
      } finally {
        await rm(stateDirectory, { recursive: true, force: true })
      }
    })
  })

  test('persists rung sizes as units under the current state version', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-'))
    try {
      const config = { chainId: base.id, maker }
      await createLadderGroupOwnership(config, { stateDirectory }).reserve({
        marketId,
        quote,
        groups: [{ groupId: higherGroup, side: 'higher', rungIndexes: [0], ticks: [100n] }]
      })
      const [stableName] = jsonFiles(stateDirectory)
      const persisted = JSON.parse(await readFile(join(stateDirectory, stableName!), 'utf8'))

      expect(persisted).toMatchObject({
        version: STRATEGY_STATE_VERSION,
        publications: [{ quote: { higher: [{ index: 0, rateBps: '550', units: '20' }] } }]
      })
      expect(
        (await createLadderGroupOwnership(config, { stateDirectory }).read())[0]?.quote
      ).toEqual(quote)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('fails loud on its own state written by an earlier version', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-'))
    try {
      const strategy = keccak256(
        stringToHex(JSON.stringify({ strategy: 'ladder', chainId: base.id, maker }))
      )
      await writeFile(
        join(stateDirectory, `${strategy}.json`),
        JSON.stringify({ version: 2, strategy, publications: [] }),
        { mode: 0o600 }
      )

      await expect(
        createLadderGroupOwnership({ chainId: base.id, maker }, { stateDirectory }).read()
      ).rejects.toBeInstanceOf(StrategyStateVersionError)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
