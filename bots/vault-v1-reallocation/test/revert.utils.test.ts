import type { Hex } from 'viem'

import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { BaseError, encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'

import { revertReason } from '../src/revert.utils'

// A viem-style error chain whose cause carries an ABI-encoded revert payload, the shape
// `revertReason` walks for (mirrors bot-kit's own revert.utils tests).
const revertError = (data: Hex): BaseError =>
  new BaseError('execution reverted', {
    cause: Object.assign(new Error('execution reverted'), { data })
  })

describe('revertReason', () => {
  it('decodes a Vault V1 custom error from revert data', () => {
    const data = encodeErrorResult({ abi: metaMorphoAbi, errorName: 'NotAllocatorRole' })
    expect(revertReason(revertError(data))).toBe('NotAllocatorRole')
  })

  it('falls back to the message for non-revert errors', () => {
    expect(revertReason(new Error('rpc exploded'))).toContain('rpc exploded')
  })
})
