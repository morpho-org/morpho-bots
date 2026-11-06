import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  Group,
  MarketUtils,
  MAX_OFFER_CAP,
  midnightAbi,
  Offer,
  Tree
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { encodeFunctionResult, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import {
  midnightCancellation,
  midnightCommitmentGroup,
  midnightCommitmentId,
  midnightCommitmentRead,
  midnightOffersValidator,
  midnightPublicationPlan,
  midnightTreeWitness
} from '../src'

const CHAIN = 8453
const ECRECOVER = getChainAddress(CHAIN, 'ecrecoverRatifier')
const SETTER = getChainAddress(CHAIN, 'setterRatifier')
// Anvil's published development key: a throwaway maker that never holds funds.
const maker = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
)
const market = {
  chainId: BigInt(CHAIN),
  midnight: getChainAddress(CHAIN, 'midnight'),
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006' as Address,
      lltv: 770_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const NOW = BigInt(Date.UTC(2026, 9, 3) / 1000)

const offer = (ratifier: Address, buy: boolean, tick: bigint) =>
  Offer.create({
    market,
    buy,
    maker: maker.address,
    start: NOW,
    expiry: market.maturity,
    ratifier,
    tick,
    maxUnits: 1_000_000n,
    continuousFeeCap: 0n,
    ...(buy ? {} : { reduceOnly: true, receiverIfMakerIsSeller: maker.address })
  } as Parameters<typeof Offer.create>[0])

/** A per-book ladder: one buy group of two offers, one reduce-only sell group. */
const ladder = (ratifier: Address) =>
  Tree.create([
    Group.create([offer(ratifier, true, 100n), offer(ratifier, true, 200n)]),
    Group.create([offer(ratifier, false, 300n)])
  ])

const validator = midnightOffersValidator({
  chainId: CHAIN,
  maker: maker.address,
  markets: [MarketUtils.toId(market)],
  maxContinuousFeeCap: 0n
})
const context = { account: maker.address, chainId: CHAIN }
const groupsOf = (tree: Tree) => [...new Set(tree.offers.map(o => midnightCommitmentId(o.group)))]

describe('Midnight plans, as the validator reads them', () => {
  it('signs an Ecrecover tree, then publishes a payload carrying that one signature over every group', async () => {
    const tree = ladder(ECRECOVER)
    const plan = midnightPublicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'ecrecover'
    })
    const [sign] = plan.steps
    const created = validator.read(sign!.payload!, sign!.witness, context)
    expect(created.ok && created.creates.map(c => c.id).toSorted()).toEqual(
      groupsOf(tree).toSorted()
    )

    const signature = await maker.signTypedData(
      EcrecoverRatifierUtils.typedData({ tree, chainId: CHAIN }) as never
    )
    const built = await plan.materialize(
      { type: 'materialize', request: 0, intentId: 'publish', step: 1, signatures: [signature] },
      new AbortController().signal
    )
    const carried = validator.read(built.payload, built.witness, context)
    expect(carried.ok && carried.carries).toEqual([signature.toLowerCase()])
    expect(carried.ok && carried.exposes.toSorted()).toEqual(groupsOf(tree).toSorted())
  })

  it('ratifies a Setter root first, and validates the exact publication it then builds', async () => {
    const tree = ladder(SETTER)
    const validated: Hex[] = []
    const plan = midnightPublicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'setter',
      validate: async publication => void validated.push(publication)
    })
    const [ratify] = plan.steps
    const created = validator.read(ratify!.payload!, ratify!.witness, context)
    expect(created.ok && created.creates.every(c => c.exposure === 'inclusion')).toBe(true)

    const built = await plan.materialize(
      { type: 'materialize', request: 0, intentId: 'publish', step: 1, signatures: [] },
      new AbortController().signal
    )
    expect(validated).toEqual([built.payload.kind === 'tx' ? built.payload.data : undefined])
    expect(validator.read(built.payload, built.witness, context).ok).toBe(true)
  })

  it('carries the tree on the step it publishes, for a materializer that holds no plan', () => {
    for (const [ratifier, tree] of [
      ['ecrecover', ladder(ECRECOVER)],
      ['setter', ladder(SETTER)]
    ] as const) {
      const plan = midnightPublicationPlan({
        chainId: CHAIN,
        maker: maker.address,
        signer: maker.address,
        tree,
        ratifier
      })
      const publish = plan.steps.at(-1)!
      expect(publish.payload).toBeUndefined()
      expect(Tree.create(publish.witness as never).root).toBe(tree.root)
    }
  })

  it('cancels one group alone and several in one multicall, each read as retiring exactly them', () => {
    const [a, b] = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] as const
    for (const groups of [[a], [a, b]]) {
      const reading = validator.read(
        midnightCancellation(CHAIN, maker.address, groups),
        undefined,
        context
      )
      expect(reading.ok && reading.retires).toEqual(groups.map(midnightCommitmentId))
    }
  })

  it('rebuilds the tree from its witness, and reads a group back from its commitment id', () => {
    const tree = ladder(ECRECOVER)
    expect(Tree.create(midnightTreeWitness(tree)).root).toBe(tree.root)
    const group = tree.offers[0]!.group
    expect(midnightCommitmentGroup(midnightCommitmentId(group))).toBe(group.toLowerCase())
  })

  it('observes a cancelled group as neutralized and a partly filled one as not', () => {
    const read = midnightCommitmentRead(CHAIN, maker.address)
    const answer = (consumed: bigint) =>
      encodeFunctionResult({ abi: midnightAbi, functionName: 'consumed', result: consumed })
    expect(read.request(midnightCommitmentId(`0x${'11'.repeat(32)}`)).to).toBe(market.midnight)
    expect(read.observe(answer(MAX_OFFER_CAP))).toEqual({
      consumed: MAX_OFFER_CAP,
      neutralized: true
    })
    expect(read.observe(answer(5n))).toEqual({ consumed: 5n, neutralized: false })
  })
})
