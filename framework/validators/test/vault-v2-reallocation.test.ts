import type { Payload, TxPayload } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { vaultV2Abi } from '@morpho-org/morpho-ts/abis'
import { marketParamsAbi } from '@morpho-org/morpho-ts/abis/marketParams'
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

import type { VaultV2Cap, VaultV2Witness } from '../src'

import { vaultV2ReallocationValidator } from '../src'
import { InvalidValidatorConfigError } from '../src/errors'
import { itReadsAsRecorded } from './recorded-readings'

const VAULT = '0x1111111111111111111111111111111111111111' as Address
const OTHER_VAULT = '0x2222222222222222222222222222222222222222' as Address
const ADAPTER = '0x3333333333333333333333333333333333333333' as Address
const OTHER_ADAPTER = '0x5555555555555555555555555555555555555555' as Address
const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address
const CONTEXT = { account: ACCOUNT, chainId: 8453 }
const WAD = 10n ** 18n
const BIG = 10n ** 30n

const marketAt = (collateral: number) => ({
  loanToken: '0x6666666666666666666666666666666666666666' as Address,
  collateralToken: `0x${'7'.repeat(39)}${collateral}` as Address,
  oracle: '0x8888888888888888888888888888888888888888' as Address,
  irm: '0x9999999999999999999999999999999999999999' as Address,
  lltv: 860_000_000_000_000_000n
})
type Params = ReturnType<typeof marketAt>
const [m1, m2, stray] = [marketAt(1), marketAt(2), marketAt(3)]

const encodeParams = (params: Params) => encodeAbiParameters([marketParamsAbi], [params])
const marketId = (params: Params) => keccak256(encodeParams(params))
const tagged = (tag: string, address: Address) =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [tag, address]))
const ids = {
  adapter: tagged('this', ADAPTER),
  c1: tagged('collateralToken', m1.collateralToken),
  c2: tagged('collateralToken', m2.collateralToken),
  m1: keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, marketParamsAbi],
      ['this/marketParams', ADAPTER, m1]
    )
  ),
  m2: keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, marketParamsAbi],
      ['this/marketParams', ADAPTER, m2]
    )
  )
}

/** Market totals at Blue's usual 1e6 shares per asset, so whole assets convert exactly. */
const TOTAL_ASSETS = 10_000n
const SHARES_PER_ASSET = 1_000_000n
const positionOf = (params: Params, assets: bigint) => ({
  market: marketId(params),
  shares: assets * SHARES_PER_ASSET,
  totalAssets: TOTAL_ASSETS,
  totalShares: TOTAL_ASSETS * SHARES_PER_ASSET
})

const cap = (id: Hex, allocation: bigint, overrides: Partial<VaultV2Cap> = {}): VaultV2Cap => ({
  id,
  absolute: BIG,
  relative: WAD,
  allocation,
  ...overrides
})
const witnessWith = (
  overrides: Partial<Record<keyof typeof ids, Partial<VaultV2Cap>>> = {},
  positions: { m1?: bigint; m2?: bigint } = {}
): VaultV2Witness => ({
  totalAssets: 1_000n,
  caps: [
    cap(ids.adapter, 500n, overrides.adapter),
    cap(ids.c1, 400n, overrides.c1),
    cap(ids.c2, 100n, overrides.c2),
    cap(ids.m1, 400n, overrides.m1),
    cap(ids.m2, 100n, overrides.m2)
  ],
  positions: [positionOf(m1, positions.m1 ?? 400n), positionOf(m2, positions.m2 ?? 100n)]
})
const vaultWitness = witnessWith()

const leg = (
  functionName: 'allocate' | 'deallocate',
  params: Params,
  assets: bigint,
  adapter = ADAPTER
): Hex =>
  encodeFunctionData({
    abi: vaultV2Abi,
    functionName,
    args: [adapter, encodeParams(params), assets]
  })
const multicall = (calls: readonly Hex[]): Hex =>
  encodeFunctionData({ abi: vaultV2Abi, functionName: 'multicall', args: [calls] })
const tx = (data: Hex, overrides: Partial<TxPayload> = {}): TxPayload => ({
  kind: 'tx',
  to: VAULT,
  data,
  value: 0n,
  ...overrides
})
const plan = multicall([leg('deallocate', m1, 100n), leg('allocate', m2, 100n)])

const validator = vaultV2ReallocationValidator({ adapters: { [VAULT]: ADAPTER } })
const read = (payload: TxPayload, witness: unknown = vaultWitness) =>
  validator.read(payload, witness, CONTEXT)

// 5 assets over 1e6 shares: the adapter's 1e6 shares read as 3, and allocating 1 more mints
// 333_333 shares, which still read as 3, so the allocation does not move.
const rounding = (absolute: bigint) =>
  witnessWith({ m2: { absolute, allocation: 3n }, c2: { allocation: 3n } }, {})
const coarse = (absolute: bigint) => ({
  ...rounding(absolute),
  positions: [
    positionOf(m1, 400n),
    { market: marketId(m2), shares: 1_000_000n, totalAssets: 5n, totalShares: 1_000_000n }
  ]
})
const allocateOne = tx(multicall([leg('allocate', m2, 1n)]))
const dear = {
  ...vaultWitness,
  positions: [
    positionOf(m1, 400n),
    { market: marketId(m2), shares: 1n, totalAssets: 2_000_000n, totalShares: 1n }
  ]
}

const refusals = [
  ['a value-bearing call', tx(plan, { value: 1n }), 'a reallocation carries no value'],
  ['a direct allocate', tx(leg('allocate', m2, 1n)), 'not multicall'],
  ['an unknown selector', tx('0xdeadbeef'), 'not multicall'],
  ['a truncated multicall', tx(plan.slice(0, 80) as Hex), 'calldata does not decode'],
  ['trailing bytes', tx(`${plan}00`), 'calldata is not canonical'],
  ['an empty multicall', tx(multicall([])), 'multicall carries no leg'],
  [
    'a nested multicall',
    tx(multicall([multicall([leg('allocate', m2, 1n)])])),
    'an inner call is not allocate or deallocate'
  ],
  [
    'another vault function inside',
    tx(
      multicall([
        encodeFunctionData({
          abi: vaultV2Abi,
          functionName: 'setIsAllocator',
          args: [ACCOUNT, true]
        })
      ])
    ),
    'an inner call is not allocate or deallocate'
  ],
  [
    'a leg with trailing bytes',
    tx(multicall([`${leg('allocate', m2, 1n)}00`])),
    'calldata is not canonical'
  ],
  [
    'an unknown adapter',
    tx(multicall([leg('allocate', m2, 1n, OTHER_ADAPTER)])),
    'a leg names an unknown adapter'
  ],
  ['a leg that moves nothing', tx(multicall([leg('allocate', m2, 0n)])), 'a leg moves nothing'],
  [
    'a deallocation after an allocation',
    tx(multicall([leg('allocate', m2, 1n), leg('deallocate', m1, 1n)])),
    'a deallocation follows an allocation'
  ],
  [
    'adapter data that is not one market',
    tx(
      multicall([
        encodeFunctionData({
          abi: vaultV2Abi,
          functionName: 'allocate',
          args: [ADAPTER, `${encodeParams(m2)}00`, 1n]
        })
      ])
    ),
    'adapter data is not one market'
  ],
  [
    'a market outside the adapter',
    tx(multicall([leg('allocate', stray, 1n)])),
    'a market is outside the adapter configuration'
  ],
  [
    'a deallocation past its position',
    tx(multicall([leg('deallocate', m1, 401n)])),
    'a deallocation exceeds its position'
  ]
] as const

const witnessRefusals = [
  ['no witness', null, 'witness does not describe the vault'],
  ['no total assets', { caps: [], positions: [] }, 'witness does not describe the vault'],
  [
    'a malformed cap',
    { ...vaultWitness, caps: [{ id: '0x01', absolute: 1n, relative: WAD, allocation: 0n }] },
    'witness names a malformed cap'
  ],
  [
    'a negative allocation',
    { ...vaultWitness, caps: [cap(ids.m1, -1n)] },
    'witness names a malformed cap'
  ],
  [
    'a cap twice',
    { ...vaultWitness, caps: [cap(ids.m1, 0n), cap(ids.m1, 0n)] },
    'witness names a cap twice'
  ],
  [
    'a malformed position',
    { ...vaultWitness, positions: [{ market: marketId(m1), assets: 1 }] },
    'witness names a malformed position'
  ],
  [
    'more shares than the market',
    { ...vaultWitness, positions: [{ ...positionOf(m1, 1n), totalShares: 1n }] },
    'witness names a malformed position'
  ],
  [
    'a position twice',
    { ...vaultWitness, positions: [vaultWitness.positions[0], vaultWitness.positions[0]] },
    'witness names a position twice'
  ]
] as const

describe('vaultV2ReallocationValidator', () => {
  it.each([
    [
      'a vault configured twice in different case',
      {
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd': ADAPTER,
        '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD': OTHER_ADAPTER
      },
      'a vault is configured twice'
    ],
    [
      'a vault that is not an address',
      { '0x1234': ADAPTER },
      'a vault or adapter is not an address'
    ],
    [
      'an adapter that is not an address',
      { [VAULT]: '0x1234' },
      'a vault or adapter is not an address'
    ],
    [
      'an adapter whose checksum is wrong',
      { [VAULT]: '0xAbCdEfabcdefabcdefabcdefabcdefabcdefabcd' },
      'a vault or adapter is not an address'
    ]
  ] as const)('refuses to be built with %s', (_, adapters, reason) => {
    expect(() =>
      vaultV2ReallocationValidator({ adapters: adapters as Record<Address, Address> })
    ).toThrow(new InvalidValidatorConfigError(reason))
  })

  it('claims only transactions to a configured vault', () => {
    expect(validator.claims(tx(plan))).toBe(true)
    expect(validator.claims(tx(plan, { to: VAULT.toLowerCase() }))).toBe(true)
    expect(validator.claims(tx(plan, { to: OTHER_VAULT }))).toBe(false)
    expect(validator.claims({ kind: 'release', channel: 'api', message: {} })).toBe(false)
  })

  it('reads a reallocation within every cap as creating no commitment', () => {
    expect(read(tx(plan))).toStrictEqual({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {}
    })
    expect(read(tx(multicall([leg('deallocate', m1, 400n)]))).ok).toBe(true)
  })

  it('reads an allocation that lands exactly on each cap', () => {
    const exact = witnessWith({ m2: { absolute: 200n }, c2: { absolute: 200n } })
    expect(read(tx(plan), exact).ok).toBe(true)
    const relative = witnessWith({ m2: { relative: WAD / 5n } })
    expect(read(tx(plan), relative).ok).toBe(true)
  })

  it('counts a position grown past its stored allocation against the caps', () => {
    const accrued = witnessWith({ m2: { absolute: 249n } }, { m2: 150n })
    expect(read(tx(plan), accrued)).toStrictEqual({
      ok: false,
      reason: 'an allocation breaches its market absolute cap'
    })
    const room = witnessWith({ m2: { absolute: 250n } }, { m2: 150n })
    expect(read(tx(plan), room).ok).toBe(true)
  })

  describe('rounds as Blue and the adapter do', () => {
    it('reads an allocation the rounding keeps within its cap', () => {
      expect(read(allocateOne, coarse(3n)).ok).toBe(true)
    })

    it('refuses one a unit past the cap the rounding leaves', () => {
      expect(read(allocateOne, coarse(2n))).toStrictEqual({
        ok: false,
        reason: 'an allocation breaches its market absolute cap'
      })
    })

    it('refuses an allocation that would mint fewer shares than assets', () => {
      expect(read(allocateOne, dear)).toStrictEqual({
        ok: false,
        reason: 'an allocation mints fewer shares than assets'
      })
    })
  })

  it('lets a deallocation leave a market already over a lowered cap', () => {
    const over = witnessWith({ m1: { absolute: 1n }, c1: { absolute: 1n } })
    expect(read(tx(multicall([leg('deallocate', m1, 100n)])), over).ok).toBe(true)
  })

  it.each(refusals)('refuses %s', (_, payload, reason) => {
    expect(read(payload)).toStrictEqual({ ok: false, reason })
  })

  it.each([
    ['market', { m2: { absolute: 199n } }],
    ['collateral', { c2: { absolute: 199n } }],
    ['adapter', { adapter: { absolute: 499n } }]
  ] as const)('refuses an allocation over its %s absolute cap', (level, overrides) => {
    expect(read(tx(multicall([leg('allocate', m2, 100n)])), witnessWith(overrides))).toStrictEqual({
      ok: false,
      reason: `an allocation breaches its ${level} absolute cap`
    })
  })

  it.each([
    ['market', { m2: { relative: WAD / 5n - 1n } }],
    ['collateral', { c2: { relative: WAD / 5n - 1n } }],
    ['adapter', { adapter: { relative: WAD / 2n } }]
  ] as const)('refuses an allocation over its %s relative cap', (level, overrides) => {
    expect(read(tx(multicall([leg('allocate', m2, 100n)])), witnessWith(overrides))).toStrictEqual({
      ok: false,
      reason: `an allocation breaches its ${level} relative cap`
    })
  })

  it('refuses a leg whose caps the witness does not name', () => {
    const missing = {
      ...vaultWitness,
      caps: vaultWitness.caps.filter(entry => entry.id !== ids.c2)
    }
    expect(read(tx(plan), missing)).toStrictEqual({
      ok: false,
      reason: 'witness does not name a cap the leg moves'
    })
  })

  it.each(witnessRefusals)('refuses a witness with %s', (_, witness, reason) => {
    expect(read(tx(plan), witness)).toStrictEqual({ ok: false, reason })
  })

  itReadsAsRecorded(
    new URL('readings/vault-v2-reallocation.json', import.meta.url),
    validator,
    () => {
      const allocate100 = tx(multicall([leg('allocate', m2, 100n)]))
      const at = (payload: Payload, witness: unknown = vaultWitness) => ({
        payload,
        witness,
        context: CONTEXT
      })
      return {
        'a reallocation': at(tx(plan)),
        'a full deallocation': at(tx(multicall([leg('deallocate', m1, 400n)]))),
        'an allocation exactly at its absolute caps': at(
          tx(plan),
          witnessWith({ m2: { absolute: 200n }, c2: { absolute: 200n } })
        ),
        'an allocation exactly at its relative cap': at(
          tx(plan),
          witnessWith({ m2: { relative: WAD / 5n } })
        ),
        'an accrued position one past its cap': at(
          tx(plan),
          witnessWith({ m2: { absolute: 249n } }, { m2: 150n })
        ),
        'an accrued position at its cap': at(
          tx(plan),
          witnessWith({ m2: { absolute: 250n } }, { m2: 150n })
        ),
        'a deallocation over a lowered cap': at(
          tx(multicall([leg('deallocate', m1, 100n)])),
          witnessWith({ m1: { absolute: 1n }, c1: { absolute: 1n } })
        ),
        'an allocation over its market absolute cap': at(
          allocate100,
          witnessWith({ m2: { absolute: 199n } })
        ),
        'an allocation over its collateral relative cap': at(
          allocate100,
          witnessWith({ c2: { relative: WAD / 5n - 1n } })
        ),
        'an allocation over its adapter absolute cap': at(
          allocate100,
          witnessWith({ adapter: { absolute: 499n } })
        ),
        'another vault': at(tx(plan, { to: OTHER_VAULT })),
        'an allocation the rounding keeps within its cap': at(allocateOne, coarse(3n)),
        'an allocation a unit past the cap the rounding leaves': at(allocateOne, coarse(2n)),
        'an allocation minting fewer shares than assets': at(allocateOne, dear),
        'a leg whose caps the witness does not name': at(tx(plan), {
          ...vaultWitness,
          caps: vaultWitness.caps.filter(entry => entry.id !== ids.c2)
        }),
        'a leg whose market cap the witness does not name': at(tx(plan), {
          ...vaultWitness,
          caps: vaultWitness.caps.filter(entry => entry.id !== ids.m2)
        }),
        'a release': at({ kind: 'release', channel: 'api', message: {} }),
        ...Object.fromEntries(refusals.map(([name, payload]) => [name, at(payload)])),
        ...Object.fromEntries(
          witnessRefusals.map(([name, witness]) => [`witness with ${name}`, at(tx(plan), witness)])
        )
      }
    }
  )

  it('refuses a payload that is not a transaction, or to another vault', () => {
    expect(
      validator.read({ kind: 'release', channel: 'api', message: {} }, vaultWitness, CONTEXT)
    ).toStrictEqual({ ok: false, reason: 'only transactions are read' })
    expect(read(tx(plan, { to: OTHER_VAULT }))).toStrictEqual({
      ok: false,
      reason: 'not a configured vault'
    })
  })
})
