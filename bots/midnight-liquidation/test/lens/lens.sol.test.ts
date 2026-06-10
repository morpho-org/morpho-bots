import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { decodeAbiParameters, encodeAbiParameters, getAddress, isAddressEqual } from 'viem'

import type { Obligation } from '../../src/execution/encode-call'
import type { LensInput, LensOut } from '../../src/lens/lens.sol'

import {
  MidnightLiquidationLens,
  decodeLensOut,
  encodeLensInput,
  lensKey,
  readMidnightLiquidationLens
} from '../../src/lens/lens.sol'

const MIDNIGHT = getAddress('0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854')
const BORROWER = getAddress('0x1111111111111111111111111111111111111111')
const CALLER = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const ID: Hex = `0x${'ab'.repeat(32)}`

const OBLIGATION: Obligation = {
  loanToken: TOKEN,
  collateralParams: [{ token: TOKEN, lltv: 860000000000000000n, maxLif: 1n, oracle: ORACLE }],
  maturity: 2000n,
  rcfThreshold: 1n,
  enterGate: ZERO,
  liquidatorGate: ZERO
}

const OBLIGATION_COMPONENTS = [
  { name: 'loanToken', type: 'address' },
  {
    name: 'collateralParams',
    type: 'tuple[]',
    components: [
      { name: 'token', type: 'address' },
      { name: 'lltv', type: 'uint256' },
      { name: 'maxLif', type: 'uint256' },
      { name: 'oracle', type: 'address' }
    ]
  },
  { name: 'maturity', type: 'uint256' },
  { name: 'rcfThreshold', type: 'uint256' },
  { name: 'enterGate', type: 'address' },
  { name: 'liquidatorGate', type: 'address' }
] as const

const LENS_OUT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'valid', type: 'bool' },
      { name: 'hasDebt', type: 'bool' },
      { name: 'healthy', type: 'bool' },
      { name: 'locked', type: 'bool' },
      { name: 'gateAllows', type: 'bool' },
      { name: 'blockTimestamp', type: 'uint64' },
      { name: 'debt', type: 'uint128' },
      { name: 'maxDebt', type: 'uint128' },
      { name: 'badDebt', type: 'uint128' },
      { name: 'activatedBitmap', type: 'uint128' },
      { name: 'bestCollateralIdx', type: 'uint8' },
      { name: 'bestCollateralAmt', type: 'uint128' },
      { name: 'bestCollateralPrice', type: 'uint256' },
      { name: 'bestCollateralMaxLif', type: 'uint256' },
      { name: 'bestCollateralLltv', type: 'uint256' },
      { name: 'obligation', type: 'tuple', components: OBLIGATION_COMPONENTS }
    ]
  }
] as const

describe('MidnightLiquidationLens', () => {
  it('compiles via soltag and binds the Midnight address into the factory call', () => {
    // Proves the soltag bun preload compiled the inline Solidity (sol``` would otherwise throw),
    // and that the lens exposes a single-array lens(bytes[]) entrypoint.
    const compiled = MidnightLiquidationLens.with(MIDNIGHT)
    expect(compiled.factoryData.length).toBeGreaterThan(2)
    expect(compiled.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const fn = compiled.abi.find(item => item.type === 'function' && item.name === 'lens')
    expect(fn).toBeDefined()
  })
})

describe('lens codecs', () => {
  it('decodes a LensOut tuple in field order, including the returned obligation', () => {
    const sample: LensOut = {
      valid: true,
      hasDebt: true,
      healthy: false,
      locked: false,
      gateAllows: true,
      blockTimestamp: 1_700_000_000n,
      debt: 1000n,
      maxDebt: 900n,
      badDebt: 5n,
      activatedBitmap: 0b101n,
      bestCollateralIdx: 2,
      bestCollateralAmt: 12345n,
      bestCollateralPrice: 10n ** 36n,
      bestCollateralMaxLif: 1036269430051813471n,
      bestCollateralLltv: 860000000000000000n,
      obligation: OBLIGATION
    }
    const encoded = encodeAbiParameters(LENS_OUT_TUPLE, [sample])
    expect(decodeLensOut(encoded)).toEqual(sample)
  })

  it('round-trips an (id, borrower, caller) lens input', () => {
    const input: LensInput = { id: ID, borrower: BORROWER, caller: CALLER }
    const encoded = encodeLensInput(input)

    const [id, borrower, caller] = decodeAbiParameters(
      [
        { name: 'id', type: 'bytes32' },
        { name: 'borrower', type: 'address' },
        { name: 'caller', type: 'address' }
      ] as const,
      encoded
    )
    expect(id).toBe(ID)
    expect(isAddressEqual(borrower, BORROWER)).toBe(true)
    expect(isAddressEqual(caller, CALLER)).toBe(true)
  })

  it('keys results by lowercased id:borrower', () => {
    expect(lensKey(ID, BORROWER)).toBe(`${ID.toLowerCase()}:${BORROWER.toLowerCase()}`)
  })

  it('exposes the deployless fetcher', () => {
    expect(typeof readMidnightLiquidationLens).toBe('function')
  })
})
