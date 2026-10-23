import { createGraph, emitTo, every, latest } from '../src'

/** A source of numbers, a running total over every write, the total's double, and its emitted orders. */
export const ledgerGraph = () => {
  const g = createGraph('ledger')
  const amounts = g.occurrences<number>('amounts')
  const orders = g.node<number>('orders')
  const total = g.fold('total', {
    reads: { amount: every(amounts) },
    emits: [orders],
    initial: 0,
    applyInput: (sum, { value }) => ({ state: sum + value, emit: [emitTo(orders, sum + value)] })
  })
  const doubled = g.map('doubled', {
    reads: { total: latest(total) },
    compute: ({ total }) => total * 2
  })
  return { g, amounts, orders, total, doubled }
}
