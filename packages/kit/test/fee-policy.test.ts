import { parseGwei } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { MissingBlockTimeError } from '../src/errors'
import { blocksFor, bumpFees, feeCeiling, initialFees, stepCap } from '../src/fee-policy'
import { NONCE_FILL_MAX_GAS } from '../src/policy'

describe('bumpFees', () => {
  it('bumps both fees by 12.5% and floors maxFee at baseFee*2 + priority', () => {
    expect(
      bumpFees({
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        baseFee: 100n,
        maxFeePerGasWei: 10_000n
      })
    ).toEqual({ kind: 'bump', fees: { maxFeePerGas: 1325n, maxPriorityFeePerGas: 1125n } })
  })

  it('applies a +1 wei floor so tiny fees still clear the replacement threshold', () => {
    // 1 * 1125/1000 floors to 1, which is not a valid replacement; the +1 floor lifts it to 2.
    expect(
      bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, baseFee: 0n, maxFeePerGasWei: 1000n })
    ).toEqual({ kind: 'bump', fees: { maxFeePerGas: 2n, maxPriorityFeePerGas: 2n } })
  })

  it('drops rather than chasing when the bumped maxFee exceeds the ceiling', () => {
    expect(
      bumpFees({
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        baseFee: 100n,
        maxFeePerGasWei: 1000n
      })
    ).toEqual({ kind: 'drop' })
  })

  it('caps optional base-fee headroom when both required bumps fit under the ceiling', () => {
    expect(
      bumpFees({
        maxFeePerGas: 22n,
        maxPriorityFeePerGas: 2n,
        baseFee: 60n,
        maxFeePerGasWei: 100n
      })
    ).toEqual({ kind: 'bump', fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 3n } })
  })
})

describe('initialFees', () => {
  it('tips 1 gwei with 2×-base-fee headroom under a comfortable cap', () => {
    expect(initialFees(10n ** 9n, 100n * 10n ** 9n)).toEqual({
      maxPriorityFeePerGas: 10n ** 9n,
      maxFeePerGas: 3n * 10n ** 9n
    })
  })

  it('tips a quarter of a cap below 4 gwei', () => {
    expect(initialFees(10n, 2n * 10n ** 9n)).toEqual({
      maxPriorityFeePerGas: 5n * 10n ** 8n,
      maxFeePerGas: 5n * 10n ** 8n + 20n
    })
  })

  // Nodes reject a pair whose tip exceeds the max fee, and two independent clamps produce them.
  it('never returns a tip above the max fee', () => {
    const values = [0n, 1n, 5_000_000n, 100_000_000n, 10n ** 9n, 300n * 10n ** 9n]
    for (const baseFee of values) {
      for (const maxFeePerGasWei of values) {
        const fees = initialFees(baseFee, maxFeePerGasWei)
        expect(fees.maxPriorityFeePerGas).toBeLessThanOrEqual(fees.maxFeePerGas)
      }
    }
  })

  it('clamps the max fee to the cap (an underpriced first send the bump path then recovers)', () => {
    expect(initialFees(50n, 10n)).toEqual({ maxPriorityFeePerGas: 3n, maxFeePerGas: 10n })
  })

  it('bids at least one wei under any positive cap, even with no base fee', () => {
    expect(initialFees(0n, 1n)).toEqual({ maxPriorityFeePerGas: 1n, maxFeePerGas: 1n })
  })

  it('lets a step under a 0.5 gwei ceiling re-bid eleven times', () => {
    const cap = stepCap(parseGwei('0.5'))
    const baseFee = parseGwei('0.005')
    let fees = initialFees(baseFee, cap)
    let rebids = 0
    for (;;) {
      const next = bumpFees({ ...fees, baseFee, maxFeePerGasWei: cap })
      if (next.kind === 'drop') break
      fees = next.fees
      rebids += 1
    }
    expect(rebids).toBe(11)
  })
})

describe('the kernel bid ruleset', () => {
  const bumpsTo = (p: bigint) =>
    bumpFees({
      maxFeePerGas: p,
      maxPriorityFeePerGas: p,
      baseFee: 0n,
      maxFeePerGasWei: 10n ** 30n
    })

  it('caps a step at the largest fee whose bump still fits under the ceiling', () => {
    for (let ceiling = 0n; ceiling <= 3_000n; ceiling++) {
      const cap = stepCap(ceiling)
      const fits = (p: bigint) => {
        const bumped = bumpsTo(p)
        return bumped.kind === 'bump' && bumped.fees.maxFeePerGas <= ceiling
      }
      if (cap >= 0n) expect(fits(cap)).toBe(true)
      expect(fits(cap + 1n)).toBe(false)
    }
  })

  it('leaves no step room under a ceiling of zero or one wei per gas', () => {
    expect(stepCap(0n)).toBeLessThan(0n)
    expect(stepCap(1n)).toBe(0n)
  })

  it('sets the fee ceiling at what the recovery bound funds for a fill, within the policy', () => {
    expect(feeCeiling(1_000n, 50n * NONCE_FILL_MAX_GAS + 1n)).toBe(50n)
    expect(feeCeiling(40n, 50n * NONCE_FILL_MAX_GAS)).toBe(40n)
  })

  it("converts a stuck time to whole blocks of the chain's block time", () => {
    expect(blocksFor(8_000, base)).toBe(4)
    expect(blocksFor(8_000, mainnet)).toBe(1)
    expect(blocksFor(8_000, { id: 4663, blockTime: 100 })).toBe(80)
    expect(() => blocksFor(8_000, { id: 1 })).toThrow(MissingBlockTimeError)
  })

  it('keeps a converted window at its floor on a chain whose blocks span more of the time', () => {
    expect(blocksFor(6_000, mainnet, 3)).toBe(3)
    expect(blocksFor(6_000, { id: 4663, blockTime: 100 }, 3)).toBe(60)
  })
})
