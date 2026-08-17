import { vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { BaseError, encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'

import { revertReason } from '../src/tx-error'

// A viem-style error chain whose cause carries an ABI-encoded revert payload, the shape
// `revertReason` walks for (mirrors bot-kit's own tx-error tests).
const revertError = (data: `0x${string}`): BaseError =>
  new BaseError('execution reverted', {
    cause: Object.assign(new Error('execution reverted'), { data })
  })

describe('revertReason', () => {
  it('decodes a VaultV2 custom error from revert data', () => {
    const data = encodeErrorResult({ abi: vaultV2Abi, errorName: 'AbsoluteCapExceeded' })
    expect(revertReason(revertError(data))).toBe('AbsoluteCapExceeded')
  })

  it('falls back to the message for non-revert errors', () => {
    expect(revertReason(new Error('rpc exploded'))).toContain('rpc exploded')
  })
})
