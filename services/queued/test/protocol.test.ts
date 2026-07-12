import { describe, expect, it } from 'bun:test'

import { parseTransactionLine, TransactionError } from '../src/protocol'

const transaction = {
  kind: 'transaction' as const,
  chainId: 8453,
  id: 'blue:0xborrower',
  to: '0x2222222222222222222222222222222222222222',
  data: '0x1234',
  value: '0',
  simulatedAtBlock: 10
} as const

describe('parseTransactionLine', () => {
  it('accepts the producer transaction shape without importing its type', () => {
    expect(parseTransactionLine(JSON.stringify(transaction), 8453)).toEqual(transaction)
  })

  it('rejects non-transactions and chain mismatches', () => {
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, kind: 'position' }), 8453)
    ).toThrow(TransactionError)
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, chainId: 1 }), 8453)
    ).toThrow(/daemon chain 8453/)
  })

  it('requires address, hex data, and decimal value', () => {
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, to: 'nope' }), 8453)
    ).toThrow(/address/)
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, data: 'wat' }), 8453)
    ).toThrow(/hex/)
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, value: '1.5' }), 8453)
    ).toThrow(/decimal/)
    expect(() =>
      parseTransactionLine(JSON.stringify({ ...transaction, value: '1' }), 8453)
    ).toThrow(/must be zero/)
  })
})
