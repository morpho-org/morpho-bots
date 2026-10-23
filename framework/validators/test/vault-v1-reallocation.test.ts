import type { TxPayload } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { metaMorphoAbi } from '@morpho-org/morpho-ts/abis'
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  keccak256,
  maxUint256,
  zeroAddress
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { VaultV1Witness } from '../src'

import { vaultV1ReallocationValidator } from '../src'
import { itReadsAsRecorded } from './recorded-readings'

const VAULT = '0x1111111111111111111111111111111111111111' as Address
const OTHER_VAULT = '0x2222222222222222222222222222222222222222' as Address
const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address
const CONTEXT = { account: ACCOUNT, chainId: 8453 }

const MARKET_PARAMS = getAbiItem({ abi: metaMorphoAbi, name: 'reallocate' }).inputs[0].components[0]
const marketAt = (collateral: number) => ({
  loanToken: '0x6666666666666666666666666666666666666666' as Address,
  collateralToken: collateral === 0 ? zeroAddress : (`0x${'7'.repeat(39)}${collateral}` as Address),
  oracle: '0x8888888888888888888888888888888888888888' as Address,
  irm: '0x9999999999999999999999999999999999999999' as Address,
  lltv: collateral === 0 ? 0n : 860_000_000_000_000_000n
})
const idOf = (params: ReturnType<typeof marketAt>) =>
  keccak256(encodeAbiParameters([MARKET_PARAMS], [params]))

const [idle, a, b] = [marketAt(0), marketAt(1), marketAt(2)]
const CAP = 10n ** 24n
const vaultWitness: VaultV1Witness = {
  markets: [idle, a, b].map(params => ({ id: idOf(params), cap: CAP, assets: 10n ** 18n }))
}

const reallocate = (allocations: readonly { marketParams: typeof a; assets: bigint }[]): Hex =>
  encodeFunctionData({ abi: metaMorphoAbi, functionName: 'reallocate', args: [allocations] })
const tx = (data: Hex, overrides: Partial<TxPayload> = {}): TxPayload => ({
  kind: 'tx',
  to: VAULT,
  data,
  value: 0n,
  ...overrides
})
const plan = reallocate([
  { marketParams: a, assets: 5n * 10n ** 18n },
  { marketParams: b, assets: maxUint256 }
])

const validator = vaultV1ReallocationValidator({ vaults: [VAULT] })
const read = (payload: TxPayload, witness: unknown = vaultWitness) =>
  validator.read(payload, witness, CONTEXT)

const refusals = [
  ['a value-bearing call', tx(plan, { value: 1n }), 'a reallocation carries no value'],
  [
    'another vault function',
    tx(encodeFunctionData({ abi: metaMorphoAbi, functionName: 'setCurator', args: [ACCOUNT] })),
    'not reallocate'
  ],
  ['an unknown selector', tx('0xdeadbeef'), 'not reallocate'],
  ['a truncated reallocate', tx(plan.slice(0, 74) as Hex), 'calldata does not decode'],
  ['trailing bytes', tx(`${plan}00`), 'calldata is not canonical'],
  ['an empty reallocate', tx(reallocate([])), 'reallocate names no market'],
  [
    'a market outside the configuration',
    tx(
      reallocate([
        { marketParams: marketAt(3), assets: 1n },
        { marketParams: b, assets: maxUint256 }
      ])
    ),
    'a market is outside the vault configuration'
  ],
  [
    'a market allocated twice',
    tx(
      reallocate([
        { marketParams: a, assets: 1n },
        { marketParams: a, assets: maxUint256 }
      ])
    ),
    'a market is allocated twice'
  ],
  [
    'an allocation over its cap',
    tx(
      reallocate([
        { marketParams: a, assets: CAP + 1n },
        { marketParams: b, assets: maxUint256 }
      ])
    ),
    'a deposit exceeds its market cap'
  ],
  [
    'the rest taken before the last leg',
    tx(
      reallocate([
        { marketParams: a, assets: maxUint256 },
        { marketParams: b, assets: 1n }
      ])
    ),
    'only the last market takes the rest'
  ]
] as const
const witnessRefusals = [
  ['no witness', null, 'witness names none of the vault markets'],
  ['no markets', { markets: [] }, 'witness names none of the vault markets'],
  [
    'a malformed id',
    { markets: [{ id: '0x01', cap: CAP, assets: 0n }] },
    'witness names a malformed market'
  ],
  [
    'a negative cap',
    { markets: [{ id: idOf(a), cap: -1n, assets: 0n }] },
    'witness names a malformed market'
  ],
  [
    'a cap that is not a bigint',
    { markets: [{ id: idOf(a), cap: 1, assets: 0n }] },
    'witness names a malformed market'
  ],
  ['no assets', { markets: [{ id: idOf(a), cap: CAP }] }, 'witness names a malformed market'],
  [
    'a market twice',
    { markets: [vaultWitness.markets[1], vaultWitness.markets[1]] },
    'witness names a market twice'
  ]
] as const

describe('vaultV1ReallocationValidator', () => {
  it('claims only transactions to a configured vault', () => {
    expect(validator.claims(tx(plan))).toBe(true)
    expect(validator.claims(tx(plan, { to: VAULT.toLowerCase() }))).toBe(true)
    expect(validator.claims(tx(plan, { to: OTHER_VAULT }))).toBe(false)
    expect(validator.claims({ kind: 'release', channel: 'api', message: {} })).toBe(false)
  })

  it('reads a reallocation within the vault configuration as creating no commitment', () => {
    expect(read(tx(plan))).toStrictEqual({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {}
    })
    const exactCap = reallocate([
      { marketParams: a, assets: CAP },
      { marketParams: idle, assets: maxUint256 }
    ])
    expect(read(tx(exactCap)).ok).toBe(true)
  })

  it('caps what the last leg takes: everything withdrawn and not yet supplied', () => {
    const rest = (cap: bigint) => ({
      markets: [
        { id: idOf(a), cap: CAP, assets: 100n },
        { id: idOf(b), cap, assets: 0n }
      ]
    })
    const drain = reallocate([
      { marketParams: a, assets: 0n },
      { marketParams: b, assets: maxUint256 }
    ])
    expect(read(tx(drain), rest(1n))).toStrictEqual({
      ok: false,
      reason: 'a deposit exceeds its market cap'
    })
    expect(read(tx(drain), rest(99n)).ok).toBe(false)
    expect(read(tx(drain), rest(100n)).ok).toBe(true)
    const split = {
      markets: [...rest(60n).markets, { id: idOf(idle), cap: CAP, assets: 0n }]
    }
    const partly = reallocate([
      { marketParams: a, assets: 0n },
      { marketParams: idle, assets: 40n },
      { marketParams: b, assets: maxUint256 }
    ])
    expect(read(tx(partly), split).ok).toBe(true)
  })

  it('reads a leg that supplies nothing to a market already over its cap', () => {
    const over = {
      markets: [
        { id: idOf(a), cap: CAP, assets: 100n },
        { id: idOf(b), cap: 1n, assets: 50n },
        { id: idOf(idle), cap: CAP, assets: 0n }
      ]
    }
    const unchanged = reallocate([
      { marketParams: a, assets: 0n },
      { marketParams: b, assets: 50n },
      { marketParams: idle, assets: maxUint256 }
    ])
    expect(read(tx(unchanged), over).ok).toBe(true)
    const nothingLeft = reallocate([
      { marketParams: idle, assets: 0n },
      { marketParams: b, assets: maxUint256 }
    ])
    expect(read(tx(nothingLeft), over).ok).toBe(true)
  })

  it('reads a withdrawal from a market already over its lowered cap', () => {
    const over = {
      markets: [
        { id: idOf(a), cap: 1n, assets: 10n ** 18n },
        { id: idOf(b), cap: CAP, assets: 0n }
      ]
    }
    const withdrawal = reallocate([
      { marketParams: a, assets: 10n ** 17n },
      { marketParams: b, assets: maxUint256 }
    ])
    expect(read(tx(withdrawal), over).ok).toBe(true)
  })

  it.each(refusals)('refuses %s', (_, payload, reason) => {
    expect(read(payload)).toStrictEqual({ ok: false, reason })
  })

  it.each(witnessRefusals)('refuses a witness with %s', (_, witness, reason) => {
    expect(read(tx(plan), witness)).toStrictEqual({ ok: false, reason })
  })

  itReadsAsRecorded(
    new URL('readings/vault-v1-reallocation.json', import.meta.url),
    validator,
    () => {
      const drain = tx(
        reallocate([
          { marketParams: a, assets: 0n },
          { marketParams: b, assets: maxUint256 }
        ])
      )
      const drainInto = (cap: bigint) => ({
        markets: [
          { id: idOf(a), cap: CAP, assets: 100n },
          { id: idOf(b), cap, assets: 0n }
        ]
      })
      return {
        'a reallocation': { payload: tx(plan), witness: vaultWitness, context: CONTEXT },
        'a deposit one past its cap': { payload: drain, witness: drainInto(99n), context: CONTEXT },
        'a deposit exactly at its cap': {
          payload: drain,
          witness: drainInto(100n),
          context: CONTEXT
        },
        'another vault': {
          payload: tx(plan, { to: OTHER_VAULT }),
          witness: vaultWitness,
          context: CONTEXT
        },
        'a release': {
          payload: { kind: 'release', channel: 'api', message: {} },
          witness: vaultWitness,
          context: CONTEXT
        },
        ...Object.fromEntries(
          refusals.map(([name, payload]) => [
            name,
            { payload, witness: vaultWitness, context: CONTEXT }
          ])
        ),
        ...Object.fromEntries(
          witnessRefusals.map(([name, witness]) => [
            `witness with ${name}`,
            { payload: tx(plan), witness, context: CONTEXT }
          ])
        )
      }
    }
  )

  it('refuses a payload that is not a transaction, or to another vault', () => {
    expect(
      validator.read({ kind: 'release', channel: 'api', message: {} }, vaultWitness, CONTEXT)
    ).toStrictEqual({ ok: false, reason: 'only transactions are read' })
    expect(validator.read(tx(plan, { to: OTHER_VAULT }), vaultWitness, CONTEXT)).toStrictEqual({
      ok: false,
      reason: 'not a configured vault'
    })
  })
})
