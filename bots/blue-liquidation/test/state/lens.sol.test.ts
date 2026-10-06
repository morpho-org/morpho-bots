import { decodeFunctionResult, encodeFunctionResult, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { BlueLiquidationLens } from '../../src/state/lens.sol'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')

describe('BlueLiquidationLens', () => {
  it('compiles via soltag and binds the Morpho address into the factory call', () => {
    // Proves the soltag/vite transform compiled the inline Solidity (sol``` would otherwise throw)
    // and that constructor binding produced a deployless factory call.
    const compiled = BlueLiquidationLens.with(MORPHO)
    expect(compiled.factoryData.length).toBeGreaterThan(2)
    expect(compiled.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('exposes a single-element-in / single-value-out per-item entrypoint', () => {
    // viem-dlc's envelope calls ONE element at a time, so the entrypoint takes a single tuple and
    // returns a single tuple — `arrayifiedAbi` derives the array-shaped wire fragment from it. This
    // also guards the backtick-truncation footgun: a stray backtick in a Solidity comment terminates
    // the sol``` template early, silently yielding an empty ABI — this would then find no entrypoint.
    const { abi } = BlueLiquidationLens.with(MORPHO)
    const lens = abi.find(item => item.type === 'function' && item.name === 'computeOne')
    expect(lens).toBeDefined()
    expect(lens?.inputs).toHaveLength(1)
    expect(lens?.inputs[0]?.type).toBe('tuple')
    expect(lens?.outputs).toHaveLength(1)
    expect(lens?.outputs[0]?.type).toBe('tuple')
    expect(lens?.stateMutability).toBe('view')
  })

  it('round-trips a raw LensOut through the soltag-generated ABI in field order', () => {
    // Exercises the exact decode path the fetcher relies on: viem decoding the soltag ABI directly
    // (field order, bool, uint64/128/256 → bigint). The `params` field is echoed offchain by the
    // fetcher and is NOT part of the Solidity struct, so the raw round-trip omits it.
    const { abi } = BlueLiquidationLens.with(MORPHO)
    const sample = {
      valid: true,
      hasDebt: true,
      healthy: false,
      blockTimestamp: 1_700_000_000n,
      borrowShares: 12_345n,
      collateral: 67_890n,
      accruedTotalBorrowAssets: 5000n * 10n ** 18n,
      totalBorrowShares: 5000n * 10n ** 24n,
      collateralPrice: 10n ** 36n,
      lltv: 860000000000000000n
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'computeOne', result: sample })
    const decoded = decodeFunctionResult({ abi, functionName: 'computeOne', data: encoded })
    expect(decoded).toEqual(sample)
  })
})
