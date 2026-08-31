import { getChainAddress } from '@morpho-org/morpho-ts'
import { getAddress } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import {
  BASE_CHAIN_ID,
  referenceLookbackBlocks,
  isSupportedChainId,
  MAINNET_CHAIN_ID,
  observabilityChainId,
  ratifierRuntimeHash,
  SUPPORTED_CHAIN_IDS,
  supportedChain
} from '../../src/config/supported-chains.utils'

describe('isSupportedChainId', () => {
  test('accepts every advertised chain and rejects others', () => {
    expect(isSupportedChainId(MAINNET_CHAIN_ID)).toBe(true)
    expect(isSupportedChainId(BASE_CHAIN_ID)).toBe(true)
    expect(SUPPORTED_CHAIN_IDS).toStrictEqual([1, 8453])
    for (const unsupported of [0, 10, 137, 8454, 42_161]) {
      expect(isSupportedChainId(unsupported)).toBe(false)
    }
  })
})

describe('supportedChain', () => {
  test('maps each supported chain ID to its viem definition', () => {
    expect(supportedChain(MAINNET_CHAIN_ID).id).toBe(mainnet.id)
    expect(supportedChain(BASE_CHAIN_ID).id).toBe(base.id)
  })
})

describe('Midnight addresses from the Morpho SDK registry', () => {
  // These are read straight from the pinned SDK registry (no local registration). The assertions
  // pin the exact deployments this bot quotes against, so an SDK downgrade or an upstream address
  // change fails here instead of at runtime on a live chain.
  test('resolves the canonical Midnight addresses on mainnet', () => {
    expect(getChainAddress(MAINNET_CHAIN_ID, 'midnight')).toBe(
      getAddress('0x471686c42792F93528B000beF54bC10E3aa2045f')
    )
    expect(getChainAddress(MAINNET_CHAIN_ID, 'midnightMempool')).toBe(
      getAddress('0xde2d62449301a09A51EbF9326EA60d2e8BF4A8F7')
    )
    expect(getChainAddress(MAINNET_CHAIN_ID, 'ecrecoverRatifier')).toBe(
      getAddress('0xAC439c81CAA6ef4C7B7E8F0110F8CE63A4b6D43e')
    )
    expect(getChainAddress(MAINNET_CHAIN_ID, 'setterRatifier')).toBe(
      getAddress('0xb72c416382c8A6399D0765CebfB032F040B00B3c')
    )
  })

  test('resolves the canonical Midnight addresses on Base', () => {
    expect(getChainAddress(BASE_CHAIN_ID, 'midnightMempool')).toBe(
      getAddress('0xdD6DCE32e21f7b020898a8258dA37355b4017993')
    )
    expect(getChainAddress(BASE_CHAIN_ID, 'ecrecoverRatifier')).toBe(
      getAddress('0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E')
    )
    expect(getChainAddress(BASE_CHAIN_ID, 'setterRatifier')).toBe(
      getAddress('0x800B5F12A61B8198a5a6EfD794Cac6699B294d63')
    )
  })

  test('keeps Morpho Blue resolvable on both supported chains', () => {
    expect(getChainAddress(MAINNET_CHAIN_ID, 'morpho')).toBe(
      getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
    )
    expect(getChainAddress(BASE_CHAIN_ID, 'morpho')).toBeDefined()
  })

  test('gives each chain a distinct Midnight singleton and mempool', () => {
    expect(getChainAddress(MAINNET_CHAIN_ID, 'midnight')).not.toBe(
      getChainAddress(BASE_CHAIN_ID, 'midnight')
    )
    expect(getChainAddress(MAINNET_CHAIN_ID, 'midnightMempool')).not.toBe(
      getChainAddress(BASE_CHAIN_ID, 'midnightMempool')
    )
  })
})

describe('ratifierRuntimeHash', () => {
  test('returns the pinned Base deployment hashes', () => {
    expect(ratifierRuntimeHash(BASE_CHAIN_ID, 'ecrecover')).toBe(
      '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
    )
    expect(ratifierRuntimeHash(BASE_CHAIN_ID, 'setter')).toBe(
      '0xace63c5b7c1b611d0b9c04df3993ce0cf24a172287c9e0755d18606b7465c235'
    )
  })

  test('returns the mainnet deployment hashes', () => {
    expect(ratifierRuntimeHash(MAINNET_CHAIN_ID, 'ecrecover')).toBe(
      '0x857f6c0c206d6be9de3794b8a9c29261f40e8037c4fb7481047303609df880cc'
    )
    expect(ratifierRuntimeHash(MAINNET_CHAIN_ID, 'setter')).toBe(
      '0x31a04caac779f54e1eaeabc85855e866fb3aa818a4c923c3a38bb0b50e4b3920'
    )
  })

  test('never reuses one chain hash on another chain', () => {
    // Ratifier runtime embeds its immutable Midnight target, so a shared hash across chains would
    // mean the setup check could accept a foreign-chain ratifier.
    for (const type of ['ecrecover', 'setter'] as const) {
      expect(ratifierRuntimeHash(MAINNET_CHAIN_ID, type)).not.toBe(
        ratifierRuntimeHash(BASE_CHAIN_ID, type)
      )
    }
  })
})

describe('referenceLookbackBlocks', () => {
  test('keeps the historical lookback at six hours on every chain', () => {
    // A fixed block count is chain-specific. 10,800 blocks is six hours at Base's two-second
    // cadence but ~36 hours at Ethereum's twelve seconds, which made setup inspect far older state
    // than the rate reader needs and fail readiness for a recently funded reference market.
    expect(referenceLookbackBlocks(BASE_CHAIN_ID)).toBe(10_800n)
    expect(referenceLookbackBlocks(MAINNET_CHAIN_ID)).toBe(1_800n)
  })

  test('matches the reference rate service six-hour window at each chain cadence', () => {
    const LOOKBACK_SECONDS = 21_600n
    for (const chainId of [BASE_CHAIN_ID, MAINNET_CHAIN_ID] as const) {
      const secondsPerBlock = BigInt(supportedChain(chainId).blockTime) / 1000n
      expect(referenceLookbackBlocks(chainId) * secondsPerBlock).toBe(LOOKBACK_SECONDS)
    }
  })
})

describe('observabilityChainId', () => {
  test('uses the configured chain when it names a supported chain', () => {
    expect(observabilityChainId({ CHAIN_ID: '1' })).toBe(MAINNET_CHAIN_ID)
    expect(observabilityChainId({ CHAIN_ID: '8453' })).toBe(BASE_CHAIN_ID)
    expect(observabilityChainId({ CHAIN_ID: '  0008453\t' })).toBe(BASE_CHAIN_ID)
  })

  test('falls back to Base without throwing so config validation reports the real error', () => {
    for (const value of [
      undefined,
      '',
      '  ',
      'base',
      '+1',
      '1.0',
      '-1',
      '10',
      '9007199254740992'
    ]) {
      expect(observabilityChainId({ CHAIN_ID: value })).toBe(BASE_CHAIN_ID)
    }
  })
})
