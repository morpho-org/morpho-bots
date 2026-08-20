import { decodeFunctionResult, encodeFunctionResult, getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { VaultV2ReallocationLens } from '../../src/state/lens.sol'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const ADAPTIVE_CURVE_IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
const VAULT_V2_FACTORY = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857')
const MARKET_V1_ADAPTER_FACTORY = getAddress('0x133baC94306B99f6dAD85c381a5be851d8DD717c')
const MARKET_V1_ADAPTER_V2_FACTORY = getAddress('0x9a1B378C43BA535cDB89934230F0D3890c51C0EB')

const compiled = () =>
  VaultV2ReallocationLens.with(
    MORPHO,
    ADAPTIVE_CURVE_IRM,
    VAULT_V2_FACTORY,
    MARKET_V1_ADAPTER_FACTORY,
    MARKET_V1_ADAPTER_V2_FACTORY
  )

const capsOut = (base: bigint) => ({
  absoluteCap: base,
  relativeCap: base + 1n,
  allocation: base + 2n
})

describe('VaultV2ReallocationLens', () => {
  it('compiles via soltag and binds all five addresses into the factory call', () => {
    // Proves the soltag/vite transform compiled the inline Solidity (sol``` would otherwise throw)
    // and that constructor binding produced a deployless factory call.
    const lens = compiled()
    expect(lens.factoryData.length).toBeGreaterThan(2)
    expect(lens.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // Every immutable is appended to the creation bytecode, so each must appear in factoryData.
    for (const immutable of [
      MORPHO,
      ADAPTIVE_CURVE_IRM,
      VAULT_V2_FACTORY,
      MARKET_V1_ADAPTER_FACTORY,
      MARKET_V1_ADAPTER_V2_FACTORY
    ]) {
      expect(lens.factoryData.toLowerCase()).toContain(immutable.slice(2).toLowerCase())
    }
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
    // (nested tuple[]s of adapters and markets, the cap triples, and the field ORDER the mapping in
    // vault-data.ts assumes).
    const { abi } = compiled()
    const sample = {
      isVaultV2: true,
      isAllocator: true,
      totalAssets: parseUnits('1000000', 6),
      idleAssets: parseUnits('5000', 6),
      adapters: [{ adapter: getAddress(`0x${'22'.repeat(20)}`), kind: 2 }],
      adapterCap: capsOut(300n),
      markets: [
        {
          id: `0x${'ab'.repeat(32)}` as const,
          capId: `0x${'cd'.repeat(32)}` as const,
          params: {
            loanToken: getAddress(`0x${'33'.repeat(20)}`),
            collateralToken: getAddress(`0x${'44'.repeat(20)}`),
            oracle: getAddress(`0x${'55'.repeat(20)}`),
            irm: ADAPTIVE_CURVE_IRM,
            lltv: parseUnits('0.86', 18)
          },
          totalSupplyAssets: parseUnits('1000000', 6),
          totalBorrowAssets: parseUnits('900000', 6),
          cap: capsOut(100n),
          collateralCap: capsOut(200n),
          vaultAssets: parseUnits('250000', 6),
          rateAtTarget: 951293759n
        }
      ]
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'lens', result: [sample] })
    const decoded = decodeFunctionResult({ abi, functionName: 'lens', data: encoded })
    expect(decoded).toEqual([sample])
  })

  it('decodes a non-VaultV2 row as zeroed fields for the fetcher to reject', () => {
    // The lens bails before touching a non-factory address: only isVaultV2 is meaningful and every
    // other field decodes to its zero value — the fetcher throws InvalidVaultError off the bit.
    const { abi } = compiled()
    const sample = {
      isVaultV2: false,
      isAllocator: false,
      totalAssets: 0n,
      idleAssets: 0n,
      adapters: [],
      adapterCap: { absoluteCap: 0n, relativeCap: 0n, allocation: 0n },
      markets: []
    }
    const encoded = encodeFunctionResult({ abi, functionName: 'lens', result: [sample] })
    expect(decodeFunctionResult({ abi, functionName: 'lens', data: encoded })).toEqual([sample])
  })
})
