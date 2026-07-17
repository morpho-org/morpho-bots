import { describe, expect, it } from 'bun:test'
import { decodeFunctionResult, encodeFunctionResult, getAddress } from 'viem'

import type { Market } from '../../src/execution/encode-call'
import type { LensOut } from '../../src/state/lens.sol'

import { MidnightLiquidationLens } from '../../src/state/lens.sol'

const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const

const MARKET: Market = {
  chainId: 8453n,
  midnight: MIDNIGHT,
  loanToken: TOKEN,
  collateralParams: [
    {
      token: TOKEN,
      lltv: 860000000000000000n,
      liquidationCursor: 250000000000000000n,
      oracle: ORACLE
    }
  ],
  maturity: 2000n,
  rcfThreshold: 1n,
  enterGate: ZERO,
  liquidatorGate: ZERO
}

describe('MidnightLiquidationLens', () => {
  it('compiles via soltag and binds the Midnight address into the factory call', () => {
    // Proves the soltag bun preload compiled the inline Solidity (sol``` would otherwise throw)
    // and that constructor binding produced a deployless factory call.
    const compiled = MidnightLiquidationLens.with(MIDNIGHT)
    expect(compiled.factoryData.length).toBeGreaterThan(2)
    expect(compiled.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('exposes a single-array-in / single-array-out lens entrypoint', () => {
    // The struct shape is what lets viem encode/decode natively (no hand-written ABI). It also
    // guards the backtick-truncation footgun: a stray backtick in a Solidity comment terminates the
    // sol``` template early, silently yielding an empty ABI — this would then find no `lens`.
    const { abi } = MidnightLiquidationLens.with(MIDNIGHT)
    const lens = abi.find(item => item.type === 'function' && item.name === 'lens')
    expect(lens).toBeDefined()
    expect(lens?.inputs).toHaveLength(1)
    expect(lens?.inputs[0]?.type).toBe('tuple[]')
    expect(lens?.outputs).toHaveLength(1)
    expect(lens?.outputs[0]?.type).toBe('tuple[]')
  })

  it('round-trips a LensOut through the soltag-generated ABI in field order', () => {
    // Replaces the old hand-written-ABI codec test: the lens now relies on viem decoding the
    // soltag ABI directly, so this exercises that exact path (field order, uint8→number,
    // uint128/uint64→bigint, and the nested Market) end to end.
    const { abi } = MidnightLiquidationLens.with(MIDNIGHT)
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
      market: MARKET
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'lens', result: [sample] })
    const decoded = decodeFunctionResult({ abi, functionName: 'lens', data: encoded })
    expect(decoded).toEqual([sample])
  })
})
