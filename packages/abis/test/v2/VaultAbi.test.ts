import { describe, expect, test } from 'bun:test'
import { getAbiItem, toFunctionSelector } from 'viem'

import { VAULT_V2_TIMELOCKED_SELECTORS, VaultAbi } from '../../src/v2/VaultAbi'

describe('VaultAbi', () => {
  test.each(Object.entries(VAULT_V2_TIMELOCKED_SELECTORS))(
    'VAULT_V2_TIMELOCKED_SELECTORS: %s is the selector for %s',
    (selector, functionName) => {
      const fn = getAbiItem({ abi: VaultAbi, name: functionName })
      const expectedSelector = toFunctionSelector(fn)

      expect(selector).toBe(expectedSelector)
    }
  )
})
