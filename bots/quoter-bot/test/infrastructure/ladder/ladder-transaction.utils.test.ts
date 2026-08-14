import type { Address, Hex } from 'viem'

import {
  Offer,
  Payload,
  SetterRatifierUtils,
  Tree,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { encodeFunctionData } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  assertLadderPublicationTransaction,
  assertLadderRatificationTransaction
} from '../../../src/infrastructure/ladder/ladder-transaction.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const foreignMaker: Address = '0x2222222222222222222222222222222222222222'
const ratifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
const root: Hex = `0x${'22'.repeat(32)}`
const foreignRoot: Hex = `0x${'44'.repeat(32)}`
const mempool: Address = '0x3333333333333333333333333333333333333333'
const loanToken: Address = '0x5555555555555555555555555555555555555555'
const collateral: Address = '0x6666666666666666666666666666666666666666'
const oracle: Address = '0x7777777777777777777777777777777777777777'
const alternateOracle: Address = '0x8888888888888888888888888888888888888888'

const approval = (ratified = true, account: Address = maker, selectedRoot: Hex = root) => ({
  to: ratifier,
  value: 0n,
  data: encodeFunctionData({
    abi: setterRatifierAbi,
    functionName: 'setIsRootRatified',
    args: [account, selectedRoot, ratified]
  })
})

const ladderOffer = (collateralOracle: Address) =>
  Offer.create({
    market: {
      chainId: 8453,
      midnight: '0x4444444444444444444444444444444444444444',
      loanToken,
      collateralParams: [
        {
          token: collateral,
          lltv: 800_000_000_000_000_000n,
          liquidationCursor: 0n,
          oracle: collateralOracle
        }
      ],
      maturity: 54_000n,
      rcfThreshold: 0n,
      enterGate: '0x0000000000000000000000000000000000000000',
      liquidatorGate: '0x0000000000000000000000000000000000000000'
    },
    buy: true,
    maker,
    tick: 100n,
    expiry: 2_000n,
    ratifier,
    maxAssets: 100n
  })

describe('assertLadderRatificationTransaction', () => {
  test('rejects canonical Setter root approval calldata with trailing bytes', () => {
    const transaction = approval()

    expect(() =>
      assertLadderRatificationTransaction(
        { ...transaction, data: `${transaction.data}deadbeef` },
        { target: ratifier, account: maker, root }
      )
    ).toThrow()
  })

  test('accepts only the configured Setter root approval', () => {
    expect(() =>
      assertLadderRatificationTransaction(approval(), { target: ratifier, account: maker, root })
    ).not.toThrow()

    const canonical = approval()
    for (const transaction of [
      { ...canonical, to: maker },
      { ...canonical, value: 1n },
      { ...canonical, data: '0xdeadbeef' as Hex },
      { ...canonical, data: canonical.data.slice(0, -2) as Hex },
      { ...canonical, data: `0xdeadbeef${canonical.data.slice(10)}` as Hex },
      approval(true, foreignMaker),
      approval(true, maker, foreignRoot),
      approval(false)
    ]) {
      expect(() =>
        assertLadderRatificationTransaction(transaction, {
          target: ratifier,
          account: maker,
          root
        })
      ).toThrow()
    }
  })
})

describe('assertLadderPublicationTransaction', () => {
  test('rejects altered ratifier data even when the offer set is unchanged', async () => {
    const offer = ladderOffer(oracle)
    const items = SetterRatifierUtils.ratify({ tree: Tree.create([offer]) })
    const validTransaction = {
      to: mempool,
      value: 0n,
      data: await Payload.encode(items)
    }
    const alteredTransaction = {
      ...validTransaction,
      data: await Payload.encode([{ ...items[0]!, ratifierData: '0x1234' }])
    }

    await expect(
      assertLadderPublicationTransaction(validTransaction, { target: mempool, items })
    ).resolves.toBeUndefined()
    await expect(
      assertLadderPublicationTransaction(alteredTransaction, { target: mempool, items })
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('rejects a payload whose nested market struct differs from the intended offer', async () => {
    const intended = ladderOffer(oracle)
    const items = SetterRatifierUtils.ratify({ tree: Tree.create([intended]) })
    const alteredItems = SetterRatifierUtils.ratify({
      tree: Tree.create([ladderOffer(alternateOracle)])
    })

    await expect(
      assertLadderPublicationTransaction(
        { to: mempool, data: await Payload.encode(alteredItems), value: 0n },
        { target: mempool, items }
      )
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })
})
