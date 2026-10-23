import type { KernelActivity, Notice, Refusal } from '@repo/kernel'

import type { Logger } from './logger'
import type { SignedFees } from './transaction-kernel'

type Level = keyof Logger
type Line = Readonly<{ level: Level; event: string; fields: Record<string, unknown> }>

/** A logger that keeps every line, level included. Test-only, as `@repo/kit/testing`. */
export const recordLogs = () => {
  const lines: Line[] = []
  const at =
    (level: Level) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, event, fields })
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error')
  }
  return { lines, logger }
}

export const TX_KEY = '0xmarket:0xborrower'
const intent = (n: number) => `${TX_KEY}#run.${n}`
export const TX_FOREIGN_INTENT = 'fill-7'

/** The fees each scenario hash bids; `0xf1` is one the kernel no longer remembers. */
export const txFeesOf = (hash: string): SignedFees | undefined =>
  hash === '0xf1'
    ? undefined
    : { maxFeePerGasWei: hash.endsWith('2') ? 9n : 5n, priorityFeePerGasWei: 1n }

const sent = (
  n: number,
  hash: string,
  nonce: number,
  status: Extract<KernelActivity, { type: 'sent' }>['status'] = 'accepted',
  kind: Extract<KernelActivity, { type: 'sent' }>['kind'] = 'step'
): KernelActivity => ({ type: 'sent', intentId: intent(n), step: 0, kind, nonce, hash, status })

const notice = (
  n: number,
  kind: Exclude<Notice, 'refused'>,
  included?: { hash: string; block: number }[],
  reason?: string
): KernelActivity => ({
  type: 'notice',
  intentId: intent(n),
  notice: kind,
  ...(reason !== undefined && { reason }),
  ...(included && { included: included.map(inclusion => ({ step: 0, ...inclusion })) })
})

const refused = (n: number, refusal: Refusal): KernelActivity => ({
  type: 'notice',
  intentId: intent(n),
  notice: 'refused',
  ...refusal
})

/**
 * Kernel transitions that reach every `tx.*` event, `kernel.alarm`, and every branch of the reporter: each intent
 * `n` of {@link TX_KEY} ends in a different way, and one foreign intent id is not the library's.
 */
export const TX_SCENARIO: readonly (readonly KernelActivity[])[] = [
  [notice(0, 'admitted'), sent(0, '0xa1', 5)],
  [sent(0, '0xa1', 5)],
  [sent(0, '0xa2', 5), notice(0, 'compensating')],
  [notice(0, 'settled', [{ hash: '0xa2', block: 9 }])],
  [sent(1, '0xb1', 6, 'unknown'), sent(1, '0xb2', 6, 'accepted', 'neutralizer')],
  [notice(1, 'compensated', [{ hash: '0xb2', block: 10 }])],
  [sent(2, '0xc1', 7), sent(2, '0xc3', 11)],
  [notice(2, 'abandoned', [], 'deadline passed')],
  [sent(3, '0xd1', 8, 'withheld'), sent(3, '0xd2', 8, 'rejected', 'neutralizer')],
  [
    refused(3, {
      code: 'evidence_predates_own_effect',
      reason: 'evidence 0xmarket:0xborrower predates our own effect on 0xmarket'
    })
  ],
  [refused(4, { code: 'lifecycle', reason: 'stopped' })],
  [notice(7, 'abandoned', [], 'deadline passed')],
  [notice(5, 'settled', [{ hash: '0x99', block: 11 }])],
  [sent(6, '0xe1', 9), notice(6, 'failed', [{ hash: '0xe1', block: 12 }], 'reverted')],
  [
    {
      type: 'sent',
      intentId: TX_FOREIGN_INTENT,
      step: 0,
      kind: 'fill',
      nonce: 10,
      hash: '0xf1',
      status: 'accepted'
    },
    { type: 'notice', intentId: TX_FOREIGN_INTENT, notice: 'settled', included: [] }
  ],
  [{ type: 'alarm', reason: 'malformed clock reading' }]
]
