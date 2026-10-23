import { vaultV2ReallocationValidator } from '@repo/validators'
import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import type { CapState } from '../src/vault-data'

import { encodeReallocation } from '../src/encode'
import { CAP_BUFFER_WAD } from '../src/math'
import { decide, witnessOf, legsOf } from '../src/reallocation'
import { createEqualizeUtilizationsStrategy } from '../src/strategies/equalize-utilizations'
import { ADAPTER, makeMarket, makeVaultData, VAULT } from './helpers'

const EOA = getAddress('0x00000000000000000000000000000000000000e0')
const HELD = parseUnits('1000', 6)
const WAD = 10n ** 18n

const strategy = createEqualizeUtilizationsStrategy({
  capBufferWad: CAP_BUFFER_WAD,
  minUtilizationDeltaBips: () => 0
})

/** Two markets on one collateral far apart in utilization, with consistent aggregate caps. */
const unbalanced = () => {
  const markets = [
    makeMarket({ utilization: parseUnits('0.95', 18), vaultAssets: HELD }),
    makeMarket({ utilization: parseUnits('0.5', 18), vaultAssets: HELD })
  ]
  const aggregate: CapState = {
    absolute: 10n ** 30n,
    relative: WAD,
    allocation: 2n * HELD
  }
  return makeVaultData(markets, {
    adapterCap: aggregate,
    collateralCaps: { [getAddress(markets[0]!.params.collateralToken)]: aggregate }
  })
}

describe('a Vault V2 reallocation decision', () => {
  it('needs the strict allocator role and the adapter the validator pins', () => {
    const vault = unbalanced()
    expect(decide({ ...vault, isAllocator: false }, strategy, ADAPTER)).toStrictEqual({
      reason: 'missing_role'
    })
    expect(decide(vault, strategy, EOA)).toStrictEqual({ reason: 'adapter_changed' })
    expect(decide(vault, strategy, ADAPTER).reallocation).toBeDefined()
  })

  it('is balanced when its strategy finds nothing to move', () => {
    const balanced = makeVaultData([
      makeMarket({ utilization: parseUnits('0.9', 18), vaultAssets: HELD })
    ])
    expect(decide(balanced, strategy, ADAPTER)).toStrictEqual({ reason: 'balanced' })
  })

  it('rests on the markets it moves and their directions, not their amounts', () => {
    const vault = unbalanced()
    const { reallocation } = decide(vault, strategy, ADAPTER)
    const [hot, cold] = vault.marketsData
    expect(legsOf(reallocation!)).toStrictEqual([
      { market: cold!.id, side: 'deallocate' },
      { market: hot!.id, side: 'allocate' }
    ])
  })

  it('encodes what the validator reads as neutral against the read it was decided on', () => {
    const vault = unbalanced()
    const { reallocation } = decide(vault, strategy, ADAPTER)
    const validator = vaultV2ReallocationValidator({ adapters: { [VAULT]: ADAPTER } })
    const read = (evidence = witnessOf(vault)) =>
      validator.read(
        { kind: 'tx', to: VAULT, data: encodeReallocation(ADAPTER, reallocation!), value: 0n },
        evidence,
        { account: EOA, chainId: 1 }
      )
    expect(read()).toMatchObject({ ok: true, creates: [], consumes: {} })
    const capped = { ...vault, adapterCap: { ...vault.adapterCap, absolute: 2n * HELD - 1n } }
    expect(read(witnessOf(capped))).toStrictEqual({
      ok: false,
      reason: 'an allocation breaches its adapter absolute cap'
    })
  })
})
