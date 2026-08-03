import { describe, expect, test } from 'bun:test'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapMempoolValidationError } from '../../../src/infrastructure/bootstrap/bootstrap-mempool-validation.error'
import { validateBootstrapMempoolPublication } from '../../../src/infrastructure/bootstrap/bootstrap-mempool-validation.utils'

describe('validateBootstrapMempoolPublication', () => {
  test('returns the unchanged prepared output after validation succeeds', async () => {
    const prepared = { groups: ['group'] }

    await expect(validateBootstrapMempoolPublication(async () => prepared)).resolves.toBe(prepared)
  })

  test('sanitizes the protocol minimum-assets rejection across duplicate SDK module instances', async () => {
    const providerError = Object.assign(new Error('untrusted provider response'), {
      name: 'MidnightMempoolValidationError',
      issues: [
        {
          rule: 'min_offer_assets_usd',
          details: { type: 'minOfferAssetsUsd', minAssets: 100_014_791n }
        },
        { rule: 'https://provider.example/?token=secret-token' }
      ]
    })

    const error = await validateBootstrapMempoolPublication(async () => {
      throw providerError
    }).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapMempoolValidationError)
    expect(error).toMatchObject({
      minimumAssets: 100_014_791n,
      issues: [{ rule: 'min_offer_assets_usd', minimumAssets: 100_014_791n }, { rule: 'unknown' }]
    })
    expect(
      JSON.stringify(error, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
    ).not.toContain('secret-token')
  })

  test('translates other SDK or provider failures into a fixed adapter operation', async () => {
    const error = await validateBootstrapMempoolPublication(async () => {
      throw new Error('https://provider.example/?token=secret-token')
    }).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'mempool-validation' })
    expect(error.message).not.toContain('secret-token')
  })
})
