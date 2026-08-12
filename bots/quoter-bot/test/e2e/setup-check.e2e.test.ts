import { midnightAbi } from '@morpho-org/midnight-sdk'
import { createWalletClient, erc20Abi, http } from 'viem'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SetupCheckReport } from '../../src/application/setup/setup-check.service'
import type { AnvilHandle } from './anvil'
import type { SetupApiHandle } from './setup-api'

import { createApplication } from '../../src/bootstrap'
import { startAnvil, stopAnvil } from './anvil'
import {
  ANVIL_DEFAULT_ACCOUNT,
  ANVIL_DEFAULT_PRIVATE_KEY,
  ANVIL_TAKER_PRIVATE_KEY,
  ECRECOVER_RATIFIER,
  MAKER_USDC_BALANCE,
  MARKET_ID,
  MAXIMUM_LEND_EXPOSURE,
  MIDNIGHT,
  NATIVE_RESERVE,
  REFERENCE_MARKET_ID,
  USDC
} from './constants'
import { startSetupApi, stopSetupApi } from './setup-api'
import { setupMaker } from './setup-maker'

const isSetupCheckReport = (value: unknown): value is SetupCheckReport =>
  typeof value === 'object' &&
  value !== null &&
  'ready' in value &&
  typeof value.ready === 'boolean' &&
  'checks' in value &&
  Array.isArray(value.checks)

const environment = (rpcUrl: string, apiBaseUrl: string) => ({
  CHAIN_ID: '8453',
  RPC_URL: rpcUrl,
  REFERENCE_RPC_URL: rpcUrl,
  MAKER_PRIVATE_KEY: ANVIL_DEFAULT_PRIVATE_KEY,
  MAKER_ADDRESS: ANVIL_DEFAULT_ACCOUNT.address,
  MIDNIGHT_ADDRESS: MIDNIGHT,
  LOAN_ASSET_ADDRESS: USDC,
  RATIFIER_ADDRESS: ECRECOVER_RATIFIER,
  MARKET_IDS: MARKET_ID,
  REFERENCE_MARKET_ID,
  NATIVE_RESERVE_WEI: String(NATIVE_RESERVE),
  MAXIMUM_LEND_EXPOSURE_ASSETS: String(MAXIMUM_LEND_EXPOSURE),
  MORPHO_API_BASE_URL: apiBaseUrl,
  ROUTER_API_BASE_URL: apiBaseUrl,
  REQUEST_TIMEOUT_MS: '30000'
})

type SetupFailure = {
  name: SetupCheckReport['checks'][number]['name']
  additionallyFailed?: readonly SetupCheckReport['checks'][number]['name'][]
  apiMode?: Parameters<SetupApiHandle['setMode']>[0]
  environment?: Record<string, string>
  mutate?: (fork: AnvilHandle) => Promise<unknown>
}

describe('quoter-bot setup check on a pinned Base fork', () => {
  let anvil: AnvilHandle | undefined
  let api: SetupApiHandle | undefined

  beforeAll(async () => {
    anvil = await startAnvil()
    api = await startSetupApi()

    const setup = await setupMaker(anvil)
    expect(setup.balance).toBe(MAKER_USDC_BALANCE)
    expect(setup.receipts.map(receipt => receipt.status)).toStrictEqual(['success', 'success'])
  }, 60_000)

  afterAll(async () => {
    await Promise.all([stopAnvil(anvil), stopSetupApi(api)])
  })

  test('returns every setup surface green for Anvil account zero', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return

    const output = await createApplication(environment(anvil.rpcUrl, api.baseUrl)).run([
      'setup-check'
    ])
    expect(isSetupCheckReport(output)).toBe(true)
    if (!isSetupCheckReport(output)) throw new TypeError('Expected setup-check report')

    expect(output.ready).toBe(true)
    expect(output.checks.map(check => [check.name, check.status])).toStrictEqual([
      ['chain', 'passed'],
      ['maker', 'passed'],
      ['native-balance', 'passed'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed'],
      ['books', 'passed'],
      ['reference', 'not-required'],
      ['offers', 'passed'],
      ['position-health', 'not-required']
    ])
  }, 60_000)

  const failures: SetupFailure[] = [
    {
      name: 'chain',
      additionallyFailed: ['ratifier', 'books'],
      mutate: fork => fork.client.setCode({ address: MIDNIGHT, bytecode: '0x' })
    },
    {
      name: 'maker',
      environment: { MAKER_PRIVATE_KEY: ANVIL_TAKER_PRIVATE_KEY }
    },
    {
      name: 'native-balance',
      mutate: fork => fork.client.setBalance({ address: ANVIL_DEFAULT_ACCOUNT.address, value: 0n })
    },
    {
      name: 'loan-allowance',
      mutate: async fork => {
        const wallet = createWalletClient({
          account: ANVIL_DEFAULT_ACCOUNT,
          chain: base,
          transport: http(fork.rpcUrl)
        })
        const hash = await wallet.writeContract({
          address: USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [MIDNIGHT, 0n]
        })
        await fork.client.waitForTransactionReceipt({ hash })
      }
    },
    {
      name: 'ratifier',
      mutate: async fork => {
        const wallet = createWalletClient({
          account: ANVIL_DEFAULT_ACCOUNT,
          chain: base,
          transport: http(fork.rpcUrl)
        })
        const hash = await wallet.writeContract({
          address: MIDNIGHT,
          abi: midnightAbi,
          functionName: 'setIsAuthorized',
          args: [ECRECOVER_RATIFIER, false, ANVIL_DEFAULT_ACCOUNT.address]
        })
        await fork.client.waitForTransactionReceipt({ hash })
      }
    },
    { name: 'books', apiMode: 'books-failed' },
    { name: 'offers', apiMode: 'offers-failed' }
  ]

  test.each(failures)(
    'fails the $name setup item against real provider boundaries',
    async failure => {
      expect(anvil).toBeDefined()
      expect(api).toBeDefined()
      if (!anvil || !api) return
      const snapshot = await anvil.client.snapshot()
      api.setMode(failure.apiMode ?? 'ready')
      try {
        await failure.mutate?.(anvil)
        const output = await createApplication({
          ...environment(anvil.rpcUrl, api.baseUrl),
          ...failure.environment
        })
          .run(['setup-check'])
          .catch(error => error.report)
        expect(isSetupCheckReport(output)).toBe(true)
        if (!isSetupCheckReport(output)) throw new TypeError('Expected setup-check report')
        expect(output.ready).toBe(false)
        const failed = new Set([failure.name, ...(failure.additionallyFailed ?? [])])
        expect(output.checks.map(check => [check.name, check.status])).toStrictEqual([
          ['chain', failed.has('chain') ? 'failed' : 'passed'],
          ['maker', failed.has('maker') ? 'failed' : 'passed'],
          ['native-balance', failed.has('native-balance') ? 'failed' : 'passed'],
          ['loan-allowance', failed.has('loan-allowance') ? 'failed' : 'passed'],
          ['ratifier', failed.has('ratifier') ? 'failed' : 'passed'],
          ['books', failed.has('books') ? 'failed' : 'passed'],
          ['reference', 'not-required'],
          ['offers', failed.has('offers') ? 'failed' : 'passed'],
          ['position-health', 'not-required']
        ])
      } finally {
        api.setMode('ready')
        await anvil.client.revert({ id: snapshot })
      }
    },
    60_000
  )
})
