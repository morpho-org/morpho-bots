import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { lensKey } from '../../src/helpers/deployless-batch-lens'

const BORROWER = getAddress('0x1111111111111111111111111111111111111111')
const ID = `0x${'ab'.repeat(32)}` as const

describe('lensKey', () => {
  it('keys results by lowercased id:borrower', () => {
    expect(lensKey(ID, BORROWER)).toBe(`${ID.toLowerCase()}:${BORROWER.toLowerCase()}`)
  })
})
