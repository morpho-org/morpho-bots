import {
  EcrecoverRatifierUtils,
  Group,
  Offer,
  Payload,
  SetterRatifierUtils,
  Tree
} from '@morpho-org/midnight-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import type { IntentOffer } from '../src/intent.utils'

import {
  buildIntentOfferTree,
  deriveEcrecoverTreeDigest,
  encodeEcrecoverPublication,
  encodeSetterPublication,
  preflightEcrecoverPublication
} from '../src/offer-tree.utils'
import { parseQuoterSignerPolicy } from '../src/policy.utils'
import {
  FIXTURE_MATURITY,
  FIXTURE_MEMPOOL,
  FIXTURE_MIDNIGHT,
  FIXTURE_RATIFIER,
  FIXTURE_ZERO_ADDRESS,
  fixtureCollateral,
  fixtureMarketEntry,
  fixtureMarketId,
  fixturePolicyDocument
} from './policy-fixture'

const privateKey = `0x${'11'.repeat(32)}` as const
const maker = privateKeyToAccount(privateKey).address

const policy = parseQuoterSignerPolicy(
  JSON.stringify(fixturePolicyDocument({ surface: 'quote', maker }))
)

const marketId = fixtureMarketId({ maturity: FIXTURE_MATURITY })

/** The exact market struct the middleware re-derives from the policy pins. */
const marketStruct = {
  chainId: 8453n,
  midnight: FIXTURE_MIDNIGHT,
  loanToken: policy.markets[0]!.loanToken,
  collateralParams: [
    {
      token: fixtureCollateral.token,
      lltv: BigInt(fixtureCollateral.lltv),
      liquidationCursor: BigInt(fixtureCollateral.liquidationCursor),
      oracle: fixtureCollateral.oracle
    }
  ],
  maturity: BigInt(FIXTURE_MATURITY),
  rcfThreshold: 0n,
  enterGate: FIXTURE_ZERO_ADDRESS,
  liquidatorGate: FIXTURE_ZERO_ADDRESS
} as const

const sdkOffer = (parameters: { readonly buy: boolean; readonly tick: bigint }) =>
  Offer.create({
    market: marketStruct,
    buy: parameters.buy,
    maker,
    start: 1756199000n,
    expiry: 1756200600n,
    tick: parameters.tick,
    callback: FIXTURE_ZERO_ADDRESS,
    callbackData: '0x',
    receiverIfMakerIsSeller: parameters.buy ? FIXTURE_ZERO_ADDRESS : maker,
    ratifier: FIXTURE_RATIFIER,
    reduceOnly: !parameters.buy,
    maxUnits: 0n,
    maxAssets: 1000000n,
    continuousFeeCap: 317097919n
  })

const intentOffer = (parameters: {
  readonly buy: boolean
  readonly tick: bigint
  readonly group: `0x${string}`
}): IntentOffer => ({
  marketId,
  buy: parameters.buy,
  start: '1756199000',
  expiry: '1756200600',
  tick: parameters.tick.toString(),
  group: parameters.group,
  callback: FIXTURE_ZERO_ADDRESS,
  callbackData: '0x',
  receiverIfMakerIsSeller: parameters.buy ? FIXTURE_ZERO_ADDRESS : maker,
  ratifier: FIXTURE_RATIFIER,
  reduceOnly: !parameters.buy,
  maxUnits: '0',
  maxAssets: '1000000',
  continuousFeeCap: '317097919'
})

const buyA = sdkOffer({ buy: true, tick: 120n })
const buyB = sdkOffer({ buy: true, tick: 124n })
const sell = sdkOffer({ buy: false, tick: 200n })
const buySharedGroup = Group.create([buyA, buyB])

describe('buildIntentOfferTree', () => {
  it('re-derives the exact SDK tree for singleton groups, injecting the pinned maker', () => {
    const expected = Tree.create([Group.create([buyA]), Group.create([sell])])

    const tree = buildIntentOfferTree(
      [
        intentOffer({ buy: true, tick: 120n, group: buyA.group }),
        intentOffer({ buy: false, tick: 200n, group: sell.group })
      ],
      policy
    )

    expect(tree.root).toBe(expected.root)
    expect(tree.leaves).toStrictEqual(expected.leaves)
    for (const offer of tree.offers) expect(offer.maker).toBe(maker)
  })

  it('re-derives shared groups from contiguous runs and matches the SDK group id', () => {
    const expected = Tree.create([buySharedGroup, Group.create([sell])])

    const tree = buildIntentOfferTree(
      [
        intentOffer({ buy: true, tick: 120n, group: buySharedGroup.id }),
        intentOffer({ buy: true, tick: 124n, group: buySharedGroup.id }),
        intentOffer({ buy: false, tick: 200n, group: sell.group })
      ],
      policy
    )

    expect(tree.root).toBe(expected.root)
  })

  it('denies a declared group id that does not re-derive from the offer contents', () => {
    expect(() =>
      buildIntentOfferTree(
        [intentOffer({ buy: true, tick: 120n, group: `0x${'99'.repeat(32)}` })],
        policy
      )
    ).toThrowError(expect.objectContaining({ check: 'group-derivation', field: 'offers[0].group' }))
  })

  it('denies a group id reappearing non-contiguously', () => {
    expect(() =>
      buildIntentOfferTree(
        [
          intentOffer({ buy: true, tick: 120n, group: buyA.group }),
          intentOffer({ buy: false, tick: 200n, group: sell.group }),
          intentOffer({ buy: true, tick: 120n, group: buyA.group })
        ],
        policy
      )
    ).toThrowError(expect.objectContaining({ check: 'group-derivation', field: 'offers[2].group' }))
  })

  it('denies a duplicated offer set the SDK rejects at tree construction', () => {
    // The declared group id re-derives (a shared group of two identical offers), so the denial
    // comes from the SDK's duplicate-leaf rejection at tree construction, not group derivation.
    const duplicatedGroup = Group.create([buyA, buyA])

    expect(() =>
      buildIntentOfferTree(
        [
          intentOffer({ buy: true, tick: 120n, group: duplicatedGroup.id }),
          intentOffer({ buy: true, tick: 120n, group: duplicatedGroup.id })
        ],
        policy
      )
    ).toThrowError(expect.objectContaining({ check: 'offer-encoding' }))
  })
})

describe('deriveEcrecoverTreeDigest', () => {
  it('matches the SDK digest for the identical tree and chain', () => {
    const tree = buildIntentOfferTree(
      [intentOffer({ buy: true, tick: 120n, group: buyA.group })],
      policy
    )

    expect(deriveEcrecoverTreeDigest(tree, 8453)).toBe(
      EcrecoverRatifierUtils.digest({ tree: Tree.create([Group.create([buyA])]), chainId: 8453n })
    )
  })
})

describe('preflightEcrecoverPublication', () => {
  it('passes a publishable set without a signature', async () => {
    const tree = buildIntentOfferTree(
      [intentOffer({ buy: true, tick: 120n, group: buyA.group })],
      policy
    )

    await expect(preflightEcrecoverPublication(tree)).resolves.toBeUndefined()
  })

  it('denies an unpublishable set before any signature exists', async () => {
    // The policy parser refuses off-schedule maturities, but a hand-built tree can still carry
    // one (the SDK offer builder does not check the schedule) — exactly the codec-only rule
    // class the preflight exists to catch before any KMS call.
    const offer = Offer.create({
      market: { ...marketStruct, maturity: 1_800_000_000n },
      buy: true,
      maker,
      start: 1756199000n,
      expiry: 1756200600n,
      tick: 120n,
      callback: FIXTURE_ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: FIXTURE_ZERO_ADDRESS,
      ratifier: FIXTURE_RATIFIER,
      reduceOnly: false,
      maxUnits: 0n,
      maxAssets: 1000000n,
      continuousFeeCap: 317097919n
    })
    const tree = Tree.create([Group.create([offer])])

    await expect(preflightEcrecoverPublication(tree)).rejects.toMatchObject({
      name: 'IntentPolicyViolationError',
      check: 'offer-encoding',
      retryable: false
    })
  })
})

describe('tick spacing pin', () => {
  it('encodes protocol-valid ticks on a finer-spaced market instead of the SDK default', () => {
    const spacingTwo = parseQuoterSignerPolicy(
      JSON.stringify(
        fixturePolicyDocument({
          surface: 'quote',
          maker,
          markets: [fixtureMarketEntry({}, { tickSpacing: '2' })]
        })
      )
    )
    const expected = Offer.create({
      market: marketStruct,
      buy: true,
      maker,
      start: 1756199000n,
      expiry: 1756200600n,
      tick: 102n,
      tickSpacing: 2n,
      callback: FIXTURE_ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: FIXTURE_ZERO_ADDRESS,
      ratifier: FIXTURE_RATIFIER,
      reduceOnly: false,
      maxUnits: 0n,
      maxAssets: 1000000n,
      continuousFeeCap: 317097919n
    })

    const tree = buildIntentOfferTree(
      [intentOffer({ buy: true, tick: 102n, group: expected.group })],
      spacingTwo
    )

    expect(tree.root).toBe(Tree.create([Group.create([expected])]).root)
  })
})

describe('publication encoding', () => {
  it('embeds a real tree signature whose recovered signer is the maker, byte-exact to decode', async () => {
    const tree = buildIntentOfferTree(
      [
        intentOffer({ buy: true, tick: 120n, group: buyA.group }),
        intentOffer({ buy: false, tick: 200n, group: sell.group })
      ],
      policy
    )
    const digest = deriveEcrecoverTreeDigest(tree, 8453)
    const signature = await privateKeyToAccount(privateKey).sign({ hash: digest })

    const publication = await encodeEcrecoverPublication({
      tree,
      maker,
      signature,
      mempool: FIXTURE_MEMPOOL
    })

    expect(publication).toMatchObject({ to: FIXTURE_MEMPOOL, value: '0' })
    const items = await Payload.decode(publication.data)
    expect(items).toHaveLength(2)
    for (const [index, item] of items.entries()) {
      const verified = await EcrecoverRatifierUtils.verifyRatifierData({
        chainId: 8453n,
        offer: item.offer,
        ratifierData: item.ratifierData
      })
      expect(verified.signer).toBe(maker)
      expect(verified.root).toBe(tree.root)
      expect(Offer.from(item.offer).hash).toBe(Offer.from(tree.offers[index]!).hash)
    }
  })

  it('rejects a signature that does not recover to the maker as a post-sign artifact fault', async () => {
    const tree = buildIntentOfferTree(
      [intentOffer({ buy: true, tick: 120n, group: buyA.group })],
      policy
    )
    const digest = deriveEcrecoverTreeDigest(tree, 8453)
    const foreign = await privateKeyToAccount(`0x${'22'.repeat(32)}`).sign({ hash: digest })

    await expect(
      encodeEcrecoverPublication({ tree, maker, signature: foreign, mempool: FIXTURE_MEMPOOL })
    ).rejects.toMatchObject({ name: 'ArtifactEncodingFailedError', stage: 'publication' })
  })

  it('encodes the setter publication without any signature, root-verified per leaf', async () => {
    const tree = buildIntentOfferTree(
      [intentOffer({ buy: true, tick: 120n, group: buyA.group })],
      policy
    )

    const publication = await encodeSetterPublication({ tree, mempool: FIXTURE_MEMPOOL })

    expect(publication).toMatchObject({ to: FIXTURE_MEMPOOL, value: '0' })
    const items = await Payload.decode(publication.data)
    expect(items).toHaveLength(1)
    const verified = await SetterRatifierUtils.verifyRatifierData({
      offer: items[0]!.offer,
      ratifierData: items[0]!.ratifierData
    })
    expect(verified.root).toBe(tree.root)
  })

  it('classifies an unpublishable set as a policy denial on the signature-free setter path', async () => {
    // The setter publication runs pre-sign, so a Mempool-codec rejection (here an off-schedule
    // maturity on a hand-built tree) must deny like the quote preflight — never as a post-sign
    // artifact fault that would imply a Sign call.
    const offer = Offer.create({
      market: { ...marketStruct, maturity: 1_800_000_000n },
      buy: true,
      maker,
      start: 1756199000n,
      expiry: 1756200600n,
      tick: 120n,
      callback: FIXTURE_ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: FIXTURE_ZERO_ADDRESS,
      ratifier: FIXTURE_RATIFIER,
      reduceOnly: false,
      maxUnits: 0n,
      maxAssets: 1000000n,
      continuousFeeCap: 317097919n
    })
    const tree = Tree.create([Group.create([offer])])

    await expect(encodeSetterPublication({ tree, mempool: FIXTURE_MEMPOOL })).rejects.toMatchObject(
      { name: 'IntentPolicyViolationError', check: 'offer-encoding', retryable: false }
    )
  })
})
