import type { Command } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { EcrecoverRatifierUtils, Offer, Payload, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { midnightPublicationPlan } from '@repo/validators'
import { zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vitest'

import type { Act } from '../../../src/application/engine/decision'

import { UnplannedPublicationError } from '../../../src/errors'
import { quoterMaterializer } from '../../../src/infrastructure/engine/quoter-plans'
import { DRY_SIGNATURE } from '../../../src/infrastructure/kernel/dry-world'

const CHAIN = 8453
// Anvil's published development key: a throwaway maker that never holds funds.
const maker = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
)
const NOW = BigInt(Date.UTC(2026, 9, 3) / 1000)
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

const evidence = (ratifier: 'ecrecoverRatifier' | 'setterRatifier') => [
  Offer.create({
    market,
    buy: false,
    maker: maker.address,
    start: NOW,
    expiry: market.maturity,
    ratifier: getChainAddress(CHAIN, ratifier),
    tick: 6_000n,
    maxUnits: 1_000_000n,
    continuousFeeCap: 0n,
    reduceOnly: true,
    receiverIfMakerIsSeller: maker.address
  } as Parameters<typeof Offer.create>[0])
]

const replacement = (offers: ReturnType<typeof evidence>): Act => ({
  kind: 'replace',
  identity: 'publication',
  payload: { cancel: [], publication: { witness: offers } } as never,
  condition: 'test'
})

const materializeCommand = (
  intentId: string,
  signatures: string[]
): Extract<Command, { type: 'materialize' }> => ({
  type: 'materialize',
  request: 0,
  intentId,
  step: 1,
  signatures
})

const materializer = (options: {
  ratifier: 'ecrecover' | 'setter'
  dry: boolean
  act?: Act
  key?: string
  validate?: Parameters<typeof quoterMaterializer>[0]['validate']
}) => {
  const materialize = quoterMaterializer({
    chainId: CHAIN,
    maker: maker.address,
    signer: maker.address,
    ratifier: () => options.ratifier,
    dry: options.dry,
    validate: options.validate ?? (async () => undefined)
  })
  return (command: Extract<Command, { type: 'materialize' }>, abort: AbortSignal) => {
    const { act } = options
    const tree =
      act?.kind === 'replace'
        ? (act.payload as unknown as { publication: { witness: unknown } }).publication.witness
        : undefined
    return materialize(
      {
        ...command,
        intentId: `${options.key ?? 'ladder:market'}#run.0`,
        ...(tree !== undefined && { witness: tree })
      },
      abort
    )
  }
}

const signal = () => new AbortController().signal

describe('quoterMaterializer', () => {
  test('publishes a live Ecrecover tree with the signature the signer made', async () => {
    const offers = evidence('ecrecoverRatifier')
    const tree = Tree.create(offers)
    const signature = await maker.signTypedData(
      EcrecoverRatifierUtils.typedData({ tree, chainId: CHAIN }) as never
    )
    const command = materializeCommand('ladder:publish', [signature])
    const expected = await midnightPublicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'ecrecover'
    }).materialize(command, signal())

    const built = await materializer({
      ratifier: 'ecrecover',
      dry: false,
      act: replacement(offers)
    })(command, signal())

    expect(built).toEqual(expected)
  })

  test('never publishes the dry signature on a live run', async () => {
    const live = materializer({
      ratifier: 'ecrecover',
      dry: false,
      act: replacement(evidence('ecrecoverRatifier'))
    })
    await expect(
      live(materializeCommand('ladder:publish', [DRY_SIGNATURE]), signal())
    ).rejects.toThrow('does not recover to signer')
  })

  test('publishes a dry Ecrecover tree with the dry signature, unsigned', async () => {
    const offers = evidence('ecrecoverRatifier')
    const built = await materializer({
      ratifier: 'ecrecover',
      dry: true,
      act: replacement(offers)
    })(materializeCommand('ladder:publish', []), signal())

    const tree = Tree.create(offers)
    const items = tree.offers.map((offer, leafIndex) => ({
      offer,
      ratifierData: EcrecoverRatifierUtils.ratifierData({
        tree,
        leafIndex: BigInt(leafIndex),
        signature: DRY_SIGNATURE as Hex
      })
    }))
    expect(built).toEqual({
      payload: {
        kind: 'tx',
        to: getChainAddress(CHAIN, 'midnightMempool'),
        data: await Payload.encode(items),
        value: 0n
      },
      witness: offers
    })
  })

  test.each([
    ['ladder:market', 'ladder'],
    ['bootstrap:market', 'bootstrap']
  ])('validates a Setter publication under %s as its workflow', async (key, workflow) => {
    const validate = vi.fn(async () => undefined)
    const built = await materializer({
      ratifier: 'setter',
      dry: false,
      act: replacement(evidence('setterRatifier')),
      key,
      validate
    })(materializeCommand('ladder:publish', []), signal())

    expect(validate).toHaveBeenCalledOnce()
    expect(validate).toHaveBeenCalledWith(
      workflow,
      expect.any(Tree),
      (built.payload as { data: Hex }).data
    )
  })

  test('builds a dry Setter publication without the live post-ratification check', async () => {
    const validate = vi.fn(async () => {
      throw new Error('the root was never ratified on the chain')
    })
    const built = await materializer({
      ratifier: 'setter',
      dry: true,
      act: replacement(evidence('setterRatifier')),
      validate
    })(materializeCommand('ladder:publish', []), signal())

    expect(validate).not.toHaveBeenCalled()
    expect(built.payload).toMatchObject({ to: getChainAddress(CHAIN, 'midnightMempool') })
  })

  test.each([
    ['an intent this run never submitted', undefined],
    [
      'a cancellation, which publishes nothing',
      { kind: 'cancel', identity: 'c', payload: { cancel: [] }, condition: 'test' } as Act
    ]
  ])('refuses to build %s', async (_, act) => {
    await expect(
      materializer({ ratifier: 'ecrecover', dry: false, act })(
        materializeCommand('ladder:publish', []),
        signal()
      )
    ).rejects.toBeInstanceOf(UnplannedPublicationError)
  })

  test('refuses a tree whose intent names no quoter market', async () => {
    const materialize = quoterMaterializer({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      ratifier: () => 'ecrecover',
      dry: true,
      validate: async () => undefined
    })
    await expect(
      materialize(
        { ...materializeCommand('startup#run.0', []), witness: evidence('ecrecoverRatifier') },
        signal()
      )
    ).rejects.toBeInstanceOf(UnplannedPublicationError)
  })
})
