import type { Payload, TxPayload } from '@repo/kernel'
import type { Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { encodeFunctionData, getAddress, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { crossedBooksValidator } from '../src'
import { itReadsAsRecorded } from './recorded-readings'

const RESOLVER = getAddress('0x1111111111111111111111111111111111111111')
const MIDNIGHT = getAddress('0x2222222222222222222222222222222222222222')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const MAKER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')

const MARKET = {
  chainId: 8453n,
  midnight: MIDNIGHT,
  loanToken: LOAN,
  collateralParams: [],
  maturity: 2_000_000_000n,
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}

type Market = typeof MARKET

const take = (
  buy: boolean,
  units: bigint,
  overrides: { market?: Partial<Market>; maker?: Hex } = {}
) => ({
  offer: {
    market: { ...MARKET, ...overrides.market },
    buy,
    maker: overrides.maker ?? MAKER,
    start: 0n,
    expiry: 2_000_000_000n,
    tick: buy ? 20n : 10n,
    group: `0x${'66'.repeat(32)}`,
    callback: zeroAddress,
    callbackData: '0x' as Hex,
    receiverIfMakerIsSeller: buy ? zeroAddress : MAKER,
    ratifier: getAddress('0x7777777777777777777777777777777777777777'),
    reduceOnly: false,
    maxUnits: units,
    maxAssets: 0n,
    continuousFeeCap: 1n
  },
  ratifierData: '0x' as Hex,
  units
})

type Take = ReturnType<typeof take>

const resolve = (sells: readonly Take[], buys: readonly Take[], minimumProfit = 1n) =>
  encodeFunctionData({
    abi: CrossedBooksResolver.abi,
    functionName: 'resolve',
    args: [sells, buys, minimumProfit]
  })

const tx = (data: Hex, overrides: Partial<TxPayload> = {}): TxPayload => ({
  kind: 'tx',
  to: RESOLVER,
  data,
  value: 0n,
  ...overrides
})

const crossing = resolve([take(false, 5n)], [take(true, 2n), take(true, 3n)])

describe('crossedBooksValidator readings', () => {
  const at = (payload: Payload, account: string = ACCOUNT) => ({
    payload,
    context: { account, chainId: 8453 }
  })

  itReadsAsRecorded(
    new URL('readings/crossed-books.json', import.meta.url),
    crossedBooksValidator({ resolver: RESOLVER, midnight: MIDNIGHT }),
    () => ({
      'a crossing of one market in equal units': at(tx(crossing)),
      'a crossing with no profit floor': at(tx(resolve([take(false, 5n)], [take(true, 5n)], 0n))),
      'a crossing with no sell offer': at(tx(resolve([], [take(true, 5n)]))),
      'a crossing with no buy offer': at(tx(resolve([take(false, 5n)], []))),
      'a sell offer taken as a buy': at(tx(resolve([take(true, 5n)], [take(true, 5n)]))),
      'a buy offer taken as a sell': at(tx(resolve([take(false, 5n)], [take(false, 5n)]))),
      'an offer taken for no units': at(
        tx(resolve([take(false, 5n), take(false, 0n)], [take(true, 5n)]))
      ),
      'sides taking unequal units': at(tx(resolve([take(false, 5n)], [take(true, 4n)]))),
      'takes in two markets': at(
        tx(resolve([take(false, 5n)], [take(true, 5n, { market: { maturity: 1n } })]))
      ),
      'a market on another Midnight': at(
        tx(
          resolve(
            [take(false, 5n, { market: { midnight: ACCOUNT } })],
            [take(true, 5n, { market: { midnight: ACCOUNT } })]
          )
        )
      ),
      'a market on another chain': at(
        tx(
          resolve(
            [take(false, 5n, { market: { chainId: 1n } })],
            [take(true, 5n, { market: { chainId: 1n } })]
          )
        )
      ),
      "a take of the account's own sell offer": at(
        tx(resolve([take(false, 5n, { maker: ACCOUNT })], [take(true, 5n)]))
      ),
      "a take of the account's own offer": at(
        tx(resolve([take(false, 5n)], [take(true, 5n, { maker: ACCOUNT })]))
      ),
      'value attached': at(tx(crossing, { value: 1n })),
      'an account that is not an address': at(tx(crossing), '0xBot'),
      'another resolver function': at(
        tx(encodeFunctionData({ abi: CrossedBooksResolver.abi, functionName: 'MIDNIGHT' }))
      ),
      'a release': at({ kind: 'release', channel: 'api', message: {} }),
      'a transaction to Midnight': at(tx(crossing, { to: MIDNIGHT }))
    })
  )
})

describe('crossedBooksValidator', () => {
  const validator = crossedBooksValidator({ resolver: RESOLVER, midnight: MIDNIGHT })
  const read = (payload: Payload, account: string = ACCOUNT) =>
    validator.read(payload, undefined, { account, chainId: 8453 })

  it('claims only transactions to the resolver, in any address case', () => {
    expect(validator.claims(tx('0x', { to: RESOLVER.toLowerCase() }))).toBe(true)
    expect(validator.claims(tx('0x', { to: MIDNIGHT }))).toBe(false)
    expect(validator.claims(tx('0x', { to: 'not-an-address' }))).toBe(false)
    expect(
      validator.claims({ kind: 'release', channel: 'api', message: {} } as unknown as Payload)
    ).toBe(false)
  })

  it.each([
    [
      'a payload that is not a transaction',
      { kind: 'release', channel: 'api', message: {} },
      'only transactions are read'
    ],
    [
      'a transaction to another target',
      tx(crossing, { to: MIDNIGHT }),
      'not the configured resolver'
    ],
    ['value attached', tx(crossing, { value: 1n }), 'a resolution carries no value'],
    ['calldata with trailing bytes', tx(`${crossing}00`), 'calldata is not canonical'],
    ['calldata cut short', tx(crossing.slice(0, -2) as Hex), 'calldata does not decode'],
    [
      'calldata that is not hex',
      tx(`${crossing.slice(0, 10)}zz` as Hex),
      'calldata does not decode'
    ]
  ])('refuses %s', (_, payload, reason) => {
    expect(read(payload as Payload)).toStrictEqual({ ok: false, reason })
  })

  it('reads a crossing of one market in equal units as creating no commitment', () => {
    expect(read(tx(crossing))).toStrictEqual({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {}
    })
  })

  it('treats every receipt as confirming, since a resolution promises no commitment', () => {
    expect(validator.confirm(tx(crossing), [])).toBe(true)
  })
})
