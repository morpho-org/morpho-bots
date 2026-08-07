import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { ConfigService } from '../../../src/config/config.service'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { MidnightLadderMakeService } from '../../../src/infrastructure/ladder/ladder-make.service'
import {
  createProductionLadderAdapters,
  publishLadderPublication
} from '../../../src/infrastructure/ladder/production-ladder'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const foreignMaker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'66'.repeat(32)}`
const groupId: Hex = `0x${'77'.repeat(32)}`
const approvalHash: Hex = `0x${'88'.repeat(32)}`
const publicationHash: Hex = `0x${'99'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 10n }]
}

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanToken,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

describe('createProductionLadderAdapters', () => {
  test('constructs read-only ports without loading a private key or starting provider reads', async () => {
    const config = ConfigService.from(environment, { readOnly: true })

    const adapters = await createProductionLadderAdapters(config)

    expect(Object.hasOwn(adapters.positions, 'readMarket')).toBe(true)
    expect(Object.hasOwn(adapters.rates, 'readRate')).toBe(true)
    expect(Object.hasOwn(adapters.make, 'readActive')).toBe(true)
  })

  test('rejects a write configuration whose key does not control the maker', async () => {
    const config = ConfigService.from({
      ...environment,
      MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      MAKER_ADDRESS: foreignMaker
    })

    const error = await (async () => {
      try {
        await createProductionLadderAdapters(config)
      } catch (value) {
        return value
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect((error as LadderAdapterError).operation).toBe('maker-private-key-mismatch')
  })
})

describe('publishLadderPublication', () => {
  test('retains the durable Setter reservation when publication receipt confirmation times out', async () => {
    const retained = new Set<Hex>()
    const service = new MidnightLadderMakeService({
      readActive: async () => undefined,
      listOwnedGroups: async () => [],
      readGroupConsumed: async () => 0n,
      listActiveGroupIds: async () => [],
      listBookOffers: async () => [],
      preparePublication: async () => ({
        groupIds: [groupId],
        groups: [{ groupId, side: 'lower', rungIndexes: [0] }],
        prospective: [],
        publish: () =>
          publishLadderPublication({
            approve: async () => ({ operation: 'ratify', txHash: approvalHash }),
            validate: async () => {},
            sendPublication: async () => ({ operation: 'publish', txHash: publicationHash }),
            confirmPublication: async () => {
              throw new Error('receipt timeout')
            }
          })
      }),
      reservePublication: async publication => {
        for (const group of publication.groups) retained.add(group.groupId)
      },
      confirmPublication: async () => {},
      releasePublication: async groupIds => {
        for (const id of groupIds) retained.delete(id)
      },
      invalidate: async () => {},
      forgetGroups: async () => {}
    })

    await expect(
      service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({
      operation: 'publication-after-ratification',
      confirmedTransactions: [{ operation: 'ratify', txHash: approvalHash }]
    })
    expect([...retained]).toEqual([groupId])
  })

  test('retains the durable Setter reservation when publication submission fails', async () => {
    const retained = new Set<Hex>()
    const service = new MidnightLadderMakeService({
      readActive: async () => undefined,
      listOwnedGroups: async () => [],
      readGroupConsumed: async () => 0n,
      listActiveGroupIds: async () => [],
      listBookOffers: async () => [],
      preparePublication: async () => ({
        groupIds: [groupId],
        groups: [{ groupId, side: 'lower', rungIndexes: [0] }],
        prospective: [],
        publish: () =>
          publishLadderPublication({
            approve: async () => ({ operation: 'ratify', txHash: approvalHash }),
            validate: async () => {},
            sendPublication: async () => {
              throw new Error('send failed')
            },
            confirmPublication: async () => {}
          })
      }),
      reservePublication: async publication => {
        for (const group of publication.groups) retained.add(group.groupId)
      },
      confirmPublication: async () => {},
      releasePublication: async groupIds => {
        for (const id of groupIds) retained.delete(id)
      },
      invalidate: async () => {},
      forgetGroups: async () => {}
    })

    await expect(
      service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({
      operation: 'publication-after-ratification',
      confirmedTransactions: [{ operation: 'ratify', txHash: approvalHash }]
    })
    expect([...retained]).toEqual([groupId])
  })
})
