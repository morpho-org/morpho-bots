import type { Entry, Notice } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { encodeLedger } from '@repo/kernel/testing'
import { midnightCommitmentId, midnightWitness } from '@repo/validators'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'
import type { QuoterEngine, StartupWithdrawal } from '../../../src/run'

import { ConfigService } from '../../../src/config/config.service'
import { OfferInvalidationFailedError } from '../../../src/errors'
import { createOfferInvalidation } from '../../../src/infrastructure/invalidation/offer-invalidation'
import { ledgerText } from '../../fixtures/kernel-ledger'

const CHAIN = 8453
const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'55'.repeat(32)}`
const foreign: Hex = `0x${'99'.repeat(32)}`
const txHash: Hex = `0x${'aa'.repeat(32)}`

const environment = {
  CHAIN_ID: String(CHAIN),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444',
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: `0x${'66'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '10',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

const market = {
  chainId: BigInt(CHAIN),
  midnight: getChainAddress(CHAIN, 'midnight'),
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006' as Address,
      lltv: 770_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}

const ledgerEntry = (start: bigint, state: Entry['state']) => {
  const offer = Offer.create({
    market,
    buy: true,
    maker,
    start,
    expiry: market.maturity,
    ratifier: getChainAddress(CHAIN, 'ecrecoverRatifier'),
    tick: 6_000n,
    maxUnits: 1_000n,
    continuousFeeCap: 0n
  } as Parameters<typeof Offer.create>[0])
  const id = midnightCommitmentId(offer.group)
  const entry = {
    spec: { id },
    state,
    intentId: 'ladder:publish:1',
    origin: {
      payload: {},
      witness: midnightWitness([{ offers: Tree.create([offer]).offers }])
    }
  }
  return { groupId: offer.group.toLowerCase() as Hex, entry }
}

const owned = ledgerEntry(1n, 'live')
const second = ledgerEntry(3n, 'exposed')
const retired = ledgerEntry(2n, 'retired')

let stateHome: string
beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), 'quoter-invalidation-'))
  const directory = join(stateHome, 'morpho-quoter-bot')
  await mkdir(directory)
  await writeFile(
    join(directory, `kernel-${CHAIN}-${maker.toLowerCase()}.json`),
    ledgerText(CHAIN, maker, [owned.entry, second.entry] as never)
  )
  vi.stubEnv('XDG_STATE_HOME', stateHome)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(stateHome, { recursive: true, force: true })
})

const replacement: Hex = `0x${'ee'.repeat(32)}`

/**
 * An engine start whose startup withdrawal ends with `notice`, including `txHash`, and leaves
 * `held` exposed or live; it stops with `outcome`. With `stopsBeforeInclusion`, the start fails
 * after sending `txHash` and `replacement`, before any inclusion.
 */
const fakeWriter = (
  options: Readonly<{
    outcome?: 'clean' | 'unsafe'
    notice?: Notice
    held?: readonly Hex[]
    stopsBeforeInclusion?: true
  }> = {}
) => {
  const calls: string[] = []
  const adopts: ((entry: Entry) => 'withdraw' | 'keep')[] = []
  const cancels: (readonly Hex[])[] = []
  const start = async (startup: {
    adopt?: (entry: Entry) => 'withdraw' | 'keep'
    cancel?: readonly Hex[]
    onStartup?: (withdrawal: StartupWithdrawal) => void
    onStartupSent?: (hash: Hex) => void
  }) => {
    calls.push('start')
    if (startup.adopt) adopts.push(startup.adopt)
    cancels.push(startup.cancel ?? [])
    startup.onStartupSent?.(txHash)
    if (options.stopsBeforeInclusion) {
      startup.onStartupSent?.(replacement)
      throw new Error('stopped')
    }
    startup.onStartup?.({
      notice: options.notice ?? 'settled',
      included: [{ step: 0, hash: txHash, block: 1, success: true }]
    })
    return {
      stop: () => void calls.push('stop'),
      stopped: Promise.resolve({ outcome: options.outcome ?? 'clean', reason: 'stop' }),
      abandon: async () => void calls.push('abandon'),
      held: () => options.held ?? []
    } as unknown as QuoterEngine
  }
  return { writer: { signer: maker, start }, calls, adopts, cancels }
}

const indexed = (id: Hex): MakerOfferGroup => ({
  id,
  consumed: 0n,
  cap: { kind: 'units', maximum: 1_000n },
  offers: [{ marketId, maker, buy: true, tick: 6_000n }]
})

const groupReads = { count: 0 }
beforeEach(() => {
  groupReads.count = 0
})

const command = (
  options: {
    writer?: ReturnType<typeof fakeWriter>['writer']
    groups?: readonly MakerOfferGroup[]
    balance?: bigint
  } = {}
) => {
  const config = options.writer
    ? ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}` })
    : ConfigService.from(environment, { readOnly: true })
  const reads = {
    client: {
      getChainId: async () => CHAIN,
      getCode: async () => '0x01' as Hex,
      getBalance: async () => options.balance ?? 100n,
      readContract: async () => true
    },
    groups: async () => {
      groupReads.count += 1
      return options.groups ?? []
    }
  }
  return createOfferInvalidation(config, {
    ...(options.writer ? { writer: options.writer } : {}),
    reads: reads as never
  })
}

const submittedBy = (events: unknown[]) => (event: unknown) => void events.push(event)

describe('createOfferInvalidation', () => {
  test('fails preflight before selecting or withdrawing anything', async () => {
    const { writer, calls } = fakeWriter()
    const error = await command({ writer, balance: 1n })
      .run()
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(OfferInvalidationFailedError)
    expect(error).toMatchObject({
      report: {
        status: 'failed',
        scope: 'all',
        matchedGroups: 0,
        failures: [{ stage: 'preflight', errorName: 'OfferInvalidationAdapterError' }]
      }
    })
    expect(calls).toEqual([])
    expect(groupReads.count).toBe(0)
  })

  test('renders without signing what write mode would cancel, held ladder groups the API has not indexed included', async () => {
    const report = await command({ groups: [indexed(foreign)] }).run()
    expect(report).toMatchObject({ status: 'logged', scope: 'all', matchedGroups: 3 })
    expect(report.invalidatedGroups.map(group => group.groupId).toSorted()).toEqual(
      [foreign, owned.groupId, second.groupId].toSorted()
    )
    expect(report.invalidatedGroups.every(group => group.txHash === undefined)).toBe(true)
    expect(await command().run({ groupId: foreign })).toEqual({
      status: 'logged',
      scope: 'group',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId: foreign }]
    })
  })

  test('withdraws every held group in one stop, reporting its hash for each', async () => {
    const { writer, calls, adopts } = fakeWriter()
    const events: unknown[] = []
    const held = [owned.groupId, second.groupId].toSorted()

    const report = await command({ writer }).run({ onTransactionSubmitted: submittedBy(events) })
    expect(report).toMatchObject({ status: 'applied', scope: 'all', matchedGroups: 2 })
    expect(report.invalidatedGroups.map(group => group.groupId).toSorted()).toEqual(held)
    expect(report.invalidatedGroups.every(group => group.txHash === txHash)).toBe(true)
    expect(calls).toEqual(['start', 'stop'])
    expect(adopts).toEqual([])
    expect(
      (events as { groupId: Hex; txHash: Hex }[]).map(event => event.groupId).toSorted()
    ).toEqual(held)
  })

  test('cancels the groups the API lists that the kernel does not hold in the same transaction', async () => {
    const { writer, cancels } = fakeWriter()
    const consumed = { ...indexed(replacement), consumed: MAX_OFFER_CAP }
    const report = await command({
      writer,
      groups: [indexed(foreign), indexed(owned.groupId), consumed]
    }).run()

    const selected = [foreign, owned.groupId, second.groupId].toSorted()
    expect(report).toMatchObject({ status: 'applied', scope: 'all', matchedGroups: 3 })
    expect(report.invalidatedGroups.map(group => group.groupId).toSorted()).toEqual(selected)
    expect(report.invalidatedGroups.every(group => group.txHash === txHash)).toBe(true)
    expect(cancels.map(groups => groups.toSorted())).toEqual([selected])
  })

  test('fails every selected group when the kernel stops unclean, keeping the hash it sent', async () => {
    const error = await command({ writer: fakeWriter({ outcome: 'unsafe' }).writer })
      .run()
      .catch((value: unknown) => value)

    expect(error).toMatchObject({
      report: {
        invalidatedGroups: [],
        failures: [
          { stage: 'invalidation', errorName: 'KernelStopError', txHash },
          { stage: 'invalidation', errorName: 'KernelStopError', txHash }
        ]
      }
    })
  })

  test('reports each group submitted once, at its first broadcast, when no receipt arrives', async () => {
    for (const groupId of [owned.groupId, undefined]) {
      const { writer } = fakeWriter({ stopsBeforeInclusion: true })
      const events: unknown[] = []
      const error = await command({ writer })
        .run({ ...(groupId ? { groupId } : {}), onTransactionSubmitted: submittedBy(events) })
        .catch((value: unknown) => value)

      expect(error).toBeInstanceOf(OfferInvalidationFailedError)
      const { report } = error as OfferInvalidationFailedError
      expect(report.invalidatedGroups).toEqual([])
      expect(report.failures).toHaveLength(groupId ? 1 : 2)
      for (const failure of report.failures)
        expect(failure).toMatchObject({ stage: 'invalidation', txHash: replacement })
      expect(events).toEqual(
        report.failures.map(failure => ({
          event: 'offer-invalidation.transaction-submitted',
          groupId: failure.groupId,
          txHash
        }))
      )
    }
  })

  test.each([
    ['did not settle', { notice: 'compensating' as const }],
    ['left the group live', { held: [owned.groupId] }]
  ])(
    'never reports a group cancelled when its withdrawal %s, keeping the hash it sent',
    async (_, outcome) => {
      for (const groupId of [owned.groupId, undefined]) {
        const { writer } = fakeWriter(outcome)
        const events: unknown[] = []
        const error = await command({ writer })
          .run({ ...(groupId ? { groupId } : {}), onTransactionSubmitted: submittedBy(events) })
          .catch((value: unknown) => value)

        expect(error).toBeInstanceOf(OfferInvalidationFailedError)
        const { report } = error as OfferInvalidationFailedError
        expect(report.invalidatedGroups).toEqual([])
        expect(report.failures).toHaveLength(groupId ? 1 : 2)
        for (const failure of report.failures)
          expect(failure).toMatchObject({
            stage: 'invalidation',
            errorName: 'KernelRefusedError',
            txHash
          })
        expect(events).toHaveLength(groupId ? 1 : 2)
      }
    }
  )

  test('withdraws one held group, keeping the rest, and cancels one it does not hold', async () => {
    const { writer, calls, adopts, cancels } = fakeWriter()
    const events: unknown[] = []

    expect(
      await command({ writer }).run({
        groupId: owned.groupId,
        onTransactionSubmitted: submittedBy(events)
      })
    ).toEqual({
      status: 'applied',
      scope: 'group',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId: owned.groupId, txHash }]
    })
    expect(calls).toEqual(['start', 'abandon'])
    expect(events).toHaveLength(1)
    expect(groupReads.count).toBe(0)
    expect(
      adopts.map(adopt => [adopt(owned.entry as Entry), adopt(retired.entry as Entry)])
    ).toEqual([['withdraw', 'keep']])

    for (const groupId of [foreign, retired.groupId]) {
      expect(await command({ writer }).run({ groupId })).toEqual({
        status: 'applied',
        scope: 'group',
        matchedGroups: 1,
        invalidatedGroups: [{ groupId, txHash }]
      })
    }
    expect(cancels).toEqual([[owned.groupId], [foreign], [retired.groupId]])
    expect(groupReads.count).toBe(0)
  })

  test('reports every group submitted even when the writer never settles', async () => {
    const events: unknown[] = []
    await command({ writer: fakeWriter().writer }).run({
      onTransactionSubmitted: event => {
        events.push(event)
        return new Promise<void>(() => {})
      }
    })
    expect(events).toHaveLength(2)
  })

  test('stops before starting the kernel, naming why, when the ledger is refused', async () => {
    await writeFile(
      join(stateHome, 'morpho-quoter-bot', `kernel-${CHAIN}-${maker.toLowerCase()}.json`),
      encodeLedger({ header: { format: 1 } } as never)
    )
    for (const groupId of [owned.groupId, undefined]) {
      const { writer, calls } = fakeWriter()
      const error = await command({ writer })
        .run(groupId ? { groupId } : {})
        .catch((value: unknown) => value)

      expect(error).toMatchObject({
        report: {
          invalidatedGroups: [],
          failures: [
            {
              stage: groupId ? 'invalidation' : 'selection',
              errorName: 'LedgerRefusedError'
            }
          ]
        }
      })
      expect(calls).toEqual([])
    }
  })

  test('reports a withdrawal even when the event writer throws', async () => {
    const { writer } = fakeWriter()
    const report = await command({ writer }).run({
      onTransactionSubmitted: () => {
        throw new Error('writer down')
      }
    })
    expect(report.invalidatedGroups).toHaveLength(2)
  })
})
