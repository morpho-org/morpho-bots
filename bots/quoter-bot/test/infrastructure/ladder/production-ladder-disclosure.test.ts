import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { Payload } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  pad,
  toFunctionSelector
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder'

import { ConfigService } from '../../../src/config/config.service'
import { createProductionLadderAdapters } from '../../../src/infrastructure/ladder/production-ladder'

const privateKey: Hex = `0x${'11'.repeat(32)}`
const maker = privateKeyToAccount(privateKey).address
const midnight = '0x2222222222222222222222222222222222222222'
const loanToken = '0x3333333333333333333333333333333333333333'
const marketId: Hex = `0x${'55'.repeat(32)}`
const maturity = 20_000n * 86_400n + 54_000n
const now = maturity - 31_536_000n

const market = {
  params: {
    chainId: 8453,
    midnight,
    loanToken,
    collateralParams: [
      {
        token: '0x5555555555555555555555555555555555555555',
        lltv: 800_000_000_000_000_000n,
        liquidationCursor: 0n,
        oracle: '0x6666666666666666666666666666666666666666'
      }
    ],
    maturity,
    rcfThreshold: 0n,
    enterGate: '0x0000000000000000000000000000000000000000',
    liquidatorGate: '0x0000000000000000000000000000000000000000'
  },
  tickSpacing: 1,
  continuousFee: 0
} as unknown as IMarket

vi.mock('@morpho-org/morpho-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@morpho-org/morpho-sdk')>()),
  morphoViemExtension: () => () => ({
    morpho: {
      midnight: () => ({
        getMarketData: async () => market,
        getPositionData: async () => ({
          market: { lossFactor: 0n },
          accrueInterest: () => ({ credit: 0n, debt: 0n })
        })
      })
    }
  })
}))

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  MAKER_PRIVATE_KEY: privateKey,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanToken,
  RATIFIER_ADDRESS: getChainAddress(8453, 'ecrecoverRatifier'),
  MARKET_IDS: marketId,
  NATIVE_RESERVE_WEI: '1',
  MAX_FEE_GWEI: '100',
  PRIORITY_FEE_GWEI: '1',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MORPHO_API_BASE_URL: 'https://api.example',
  LADDER_MARKETS: JSON.stringify([
    {
      marketId,
      targetRate: { strategy: 'hardcoded', hardcodedRateBps: '500' },
      quotePremiumBps: '0',
      spreadBps: '200',
      stepBps: '100',
      rungCount: '1',
      sizeSkewBps: '0',
      lowerRateBudgetAssets: '10',
      higherRateBudgetAssets: '10',
      targetMarketExposureAssets: '20',
      maximumTotalExposureAssets: '20',
      minimumOfferAssets: '1',
      groupMode: 'shared-rung',
      loopIntervalSeconds: '60',
      movementToleranceBps: '10',
      minimumRateBps: '200',
      maximumRateBps: '800'
    }
  ])
}

const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [],
  higher: [{ index: 0, rateBps: 600n, assets: 10_000_000n }]
}

const zeroWord = pad('0x0')

const callResult = (data: Hex) => {
  if (!data.startsWith('0x82ad56cb')) return zeroWord
  const { args } = decodeFunctionData({ abi: multicall3Abi, data })
  const calls = args[0] as readonly unknown[]
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    result: calls.map(() => ({ success: true, returnData: zeroWord }))
  })
}

const rpcResult = (method: string, params: readonly unknown[] = []) => {
  if (method === 'eth_chainId') return '0x2105'
  if (method === 'eth_blockNumber') return '0x2000000'
  if (method === 'eth_call') return callResult((params[0] as { data: Hex }).data)
  if (method === 'eth_getBlockByNumber') {
    return {
      number: '0x2000000',
      timestamp: `0x${now.toString(16)}`,
      hash: `0x${'ab'.repeat(32)}`,
      parentHash: `0x${'cd'.repeat(32)}`,
      baseFeePerGas: '0x1',
      gasLimit: '0x1',
      gasUsed: '0x0',
      transactions: []
    }
  }
  throw new Error(`unexpected RPC method ${method}`)
}

describe('createProductionLadderAdapters Ecrecover disclosure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test('sends no signed payload to Mempool validation before admission withholds it', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-disclosure-'))
    vi.stubEnv('XDG_STATE_HOME', stateDirectory)
    const validations: Hex[] = []
    const transactions: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('https://rpc.example')) {
        const body = JSON.parse(init?.body as string) as {
          id: number
          method: string
          params?: unknown[]
        }
        if (body.method.startsWith('eth_send')) transactions.push(body.method)
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: rpcResult(body.method, body.params)
        })
      }
      if (url.includes('/mempool/validate')) {
        const bodyText =
          input instanceof Request ? await input.clone().text() : (init?.body as string)
        validations.push((JSON.parse(bodyText) as { payload: Hex }).payload)
        return Response.json({ data: { issues: [] } })
      }
      if (url.includes('/offer-groups')) return Response.json({ data: [], cursor: null })
      if (url.includes('/takeable-offers')) return Response.json({ data: [] })
      throw new Error(`unexpected request ${url}`)
    })

    try {
      const adapters = await createProductionLadderAdapters(ConfigService.from(environment))

      const result = await adapters.make.reconcile({ marketId, desired: quote, reason: 'publish' })

      expect(result).toMatchObject({ publicationWithheld: { reason: 'capacity-changed' } })
      expect(transactions).toEqual([])
      expect(validations.length).toBeGreaterThan(0)
      for (const payload of validations) {
        const items = await Payload.decode(payload)
        expect(items.map(item => item.ratifierData)).toEqual(items.map(() => '0x'))
      }
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})

describe('createProductionLadderAdapters lend guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('reads the market loss factor alone and pairs it with the accepted value', async () => {
    const selector = toFunctionSelector('lossFactor(bytes32)')
    const calls: Hex[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as {
        id: number
        method: string
        params?: unknown[]
      }
      const data = (body.params?.[0] as { data?: Hex } | undefined)?.data
      if (body.method === 'eth_call' && data) calls.push(data.slice(0, 10) as Hex)
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'eth_call' && data?.startsWith(selector)
            ? pad('0x7')
            : rpcResult(body.method, body.params)
      })
    })

    const adapters = await createProductionLadderAdapters(
      ConfigService.from(
        { ...environment, ACCEPTED_LOSS_FACTOR: JSON.stringify({ [marketId]: '7' }) },
        { readOnly: true }
      )
    )

    expect(await adapters.positions.readLendGuard(marketId)).toEqual({
      lossFactor: 7n,
      acceptedLossFactor: 7n,
      defaulted: false
    })
    expect(calls).toEqual([selector])
  })
})
