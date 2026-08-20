import { decodeFunctionResult, encodeFunctionResult, getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { VaultV1ReallocationLens } from '../../src/state/lens.sol'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const ADAPTIVE_CURVE_IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')

const compiled = () => VaultV1ReallocationLens.with(MORPHO, ADAPTIVE_CURVE_IRM)

describe('VaultV1ReallocationLens', () => {
  it('compiles via soltag and binds both addresses into the factory call', () => {
    // Proves the soltag/vite transform compiled the inline Solidity (sol``` would otherwise throw)
    // and that constructor binding produced a deployless factory call.
    const lens = compiled()
    expect(lens.factoryData.length).toBeGreaterThan(2)
    expect(lens.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // Both immutables are appended to the creation bytecode, so each must appear in factoryData.
    expect(lens.factoryData.toLowerCase()).toContain(MORPHO.slice(2).toLowerCase())
    expect(lens.factoryData.toLowerCase()).toContain(ADAPTIVE_CURVE_IRM.slice(2).toLowerCase())
  })

  it('exposes a single-array-in / single-array-out lens entrypoint', () => {
    // The struct shape is what lets viem encode/decode natively (no hand-written ABI). It also
    // guards the backtick-truncation footgun: a stray backtick in a Solidity comment terminates the
    // sol``` template early, silently yielding an empty ABI — this would then find no `lens`.
    const { abi } = compiled()
    const lens = abi.find(item => item.type === 'function' && item.name === 'lens')
    expect(lens).toBeDefined()
    expect(lens?.inputs).toHaveLength(1)
    expect(lens?.inputs[0]?.type).toBe('tuple[]')
    expect(lens?.outputs).toHaveLength(1)
    expect(lens?.outputs[0]?.type).toBe('tuple[]')
  })

  it('declares the entrypoint state-changing, since it accrues interest on-chain', () => {
    // The accrual is the whole point of the lens — if this ever reads `view`, the `accrueInterest`
    // call was dropped and the snapshot silently reverted to pre-accrual state.
    const { abi } = compiled()
    const lens = abi.find(item => item.type === 'function' && item.name === 'lens')
    expect(lens?.stateMutability).toBe('nonpayable')
  })

  it('round-trips a VaultOut through the soltag-generated ABI in field order', () => {
    // Exercises the exact decode path the fetcher relies on: viem decoding the soltag ABI directly
    // (nested tuple[] of markets, bool, uint256 → bigint, and the field ORDER the mapping in
    // vault-data.ts assumes).
    const { abi } = compiled()
    const sample = {
      owner: getAddress(`0x${'11'.repeat(20)}`),
      curator: getAddress(`0x${'22'.repeat(20)}`),
      isAllocator: true,
      markets: [
        {
          id: `0x${'ab'.repeat(32)}` as const,
          params: {
            loanToken: getAddress(`0x${'33'.repeat(20)}`),
            collateralToken: getAddress(`0x${'44'.repeat(20)}`),
            oracle: getAddress(`0x${'55'.repeat(20)}`),
            irm: ADAPTIVE_CURVE_IRM,
            lltv: parseUnits('0.86', 18)
          },
          totalSupplyAssets: parseUnits('1000000', 6),
          totalBorrowAssets: parseUnits('900000', 6),
          cap: parseUnits('5000000', 6),
          vaultAssets: parseUnits('250000', 6),
          rateAtTarget: 951293759n
        }
      ]
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'lens', result: [sample] })
    const decoded = decodeFunctionResult({ abi, functionName: 'lens', data: encoded })
    expect(decoded).toEqual([sample])
  })

  it('decodes an empty withdraw queue as a vault with no markets', () => {
    // A whitelisted-but-empty vault must decode to a role-bearing row with zero markets, not throw —
    // the strategies then simply produce no plan.
    const { abi } = compiled()
    const sample = {
      owner: getAddress(`0x${'11'.repeat(20)}`),
      curator: getAddress(`0x${'22'.repeat(20)}`),
      isAllocator: false,
      markets: []
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'lens', result: [sample] })
    expect(decodeFunctionResult({ abi, functionName: 'lens', data: encoded })).toEqual([sample])
  })
})
