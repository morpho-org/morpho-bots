import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SetupCheckReport } from '../../src/application/setup/setup-check.service'
import type { AnvilHandle } from './anvil'
import type { SetupApiHandle } from './setup-api'

import { createApplication } from '../../src/bootstrap'
import { startAnvil, stopAnvil } from './anvil'
import {
  ANVIL_DEFAULT_ACCOUNT,
  ANVIL_DEFAULT_PRIVATE_KEY,
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

describe('market-making setup check on a pinned Base fork', () => {
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

    const output = await createApplication({
      CHAIN_ID: '8453',
      RPC_URL: anvil.rpcUrl,
      REFERENCE_RPC_URL: anvil.rpcUrl,
      MAKER_PRIVATE_KEY: ANVIL_DEFAULT_PRIVATE_KEY,
      MAKER_ADDRESS: ANVIL_DEFAULT_ACCOUNT.address,
      MIDNIGHT_ADDRESS: MIDNIGHT,
      LOAN_ASSET_ADDRESS: USDC,
      RATIFIER_ADDRESS: ECRECOVER_RATIFIER,
      MARKET_IDS: MARKET_ID,
      REFERENCE_MARKET_ID,
      NATIVE_RESERVE_WEI: String(NATIVE_RESERVE),
      MAXIMUM_LEND_EXPOSURE_ASSETS: String(MAXIMUM_LEND_EXPOSURE),
      MORPHO_API_BASE_URL: api.baseUrl,
      ROUTER_API_BASE_URL: api.baseUrl,
      REQUEST_TIMEOUT_MS: '30000'
    }).run(['setup-check'])
    expect(isSetupCheckReport(output)).toBe(true)
    if (!isSetupCheckReport(output)) throw new Error('Expected setup-check report')
    const report = output

    expect(report.ready).toBe(true)
    expect(report.checks.map(check => [check.name, check.status])).toStrictEqual([
      ['chain', 'passed'],
      ['maker', 'passed'],
      ['native-balance', 'passed'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed'],
      ['books', 'passed'],
      ['reference', 'passed'],
      ['offers', 'passed'],
      ['position-health', 'not-required']
    ])
  }, 60_000)
})
