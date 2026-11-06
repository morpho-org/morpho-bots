import type { Payload as KernelPayload, TxPayload, TypedPayload } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  Group,
  GroupUtils,
  MarketUtils,
  MAX_CONTINUOUS_FEE,
  MAX_OFFER_CAP,
  midnightAbi,
  Offer,
  OfferUtils,
  Payload,
  SetterRatifierUtils,
  setterRatifierAbi,
  Tree
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { asStored } from '@repo/kernel/testing'
import {
  bytesToHex,
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  hexToBytes,
  zeroAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { midnightCommitmentId, midnightWitness, midnightOffersValidator } from '../src'
import { decodePayload } from '../src/midnight-payload'
import { itReadsAsRecorded } from './recorded-readings'

const CHAIN = 8453
const MIDNIGHT = getChainAddress(CHAIN, 'midnight')
const MEMPOOL = getChainAddress(CHAIN, 'midnightMempool')
const ECRECOVER = getChainAddress(CHAIN, 'ecrecoverRatifier')
const SETTER = getChainAddress(CHAIN, 'setterRatifier')

// Anvil's published development key: a throwaway maker that never holds funds.
const maker = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
)
const OTHER = '0x0000000000000000000000000000000000000bad' as Address

const market = {
  chainId: BigInt(CHAIN),
  midnight: MIDNIGHT,
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
const MARKET_ID = MarketUtils.toId(market)
const NOW = BigInt(Date.UTC(2026, 9, 3) / 1000)

const offer = (
  ratifier: Address,
  buy: boolean,
  tick: bigint,
  extra: Record<string, unknown> = {}
) =>
  Offer.create({
    market,
    buy,
    maker: maker.address,
    start: NOW,
    expiry: market.maturity,
    ratifier,
    tick,
    maxAssets: 1_000_000n,
    continuousFeeCap: FEE_CAP,
    ...(buy ? {} : { reduceOnly: true, receiverIfMakerIsSeller: maker.address }),
    ...extra
  } as Parameters<typeof Offer.create>[0])

/** A two-book ladder as the quoter builds it in per-book mode: one buy group, one reduce-only sell group. */
const ladder = (ratifier: Address) => [
  Group.create([offer(ratifier, true, 100n), offer(ratifier, true, 200n)]),
  Group.create([offer(ratifier, false, 300n)])
]

const FEE_CAP = MAX_CONTINUOUS_FEE / 2n

const validator = midnightOffersValidator({
  chainId: CHAIN,
  maker: maker.address,
  markets: [MARKET_ID],
  maxContinuousFeeCap: FEE_CAP
})
const context = { account: maker.address, chainId: CHAIN }
const read = (payload: KernelPayload, witness: unknown) => validator.read(payload, witness, context)

const typed = (tree: Tree): TypedPayload => {
  const data = EcrecoverRatifierUtils.typedData({ tree, chainId: CHAIN })
  return { kind: 'typed', ...(data as Omit<TypedPayload, 'kind'>) }
}

const signed = async (tree: Tree) => {
  const data = EcrecoverRatifierUtils.typedData({ tree, chainId: CHAIN })
  const signature = await maker.signTypedData(data as Parameters<typeof maker.signTypedData>[0])
  const items = await EcrecoverRatifierUtils.ratify({ tree, account: maker.address, signature })
  return { signature, data: await Payload.encode(items) }
}

const byText = (a?: string, b?: string) => (a ?? '').localeCompare(b ?? '')

const tx = (to: Address, data: Hex): TxPayload => ({ kind: 'tx', to, data, value: 0n })
const cancel = (group: Hex, amount = MAX_OFFER_CAP, onBehalf: Address = maker.address) =>
  encodeFunctionData({
    abi: midnightAbi,
    functionName: 'setConsumed',
    args: [group, amount, onBehalf]
  })

describe('the Midnight offers validator, against SDK-built quoter actions', () => {
  it('reads an ecrecover signature as one commitment per group: buys reserve loan, reduce-only sells nothing', () => {
    const entries = ladder(ECRECOVER)
    const tree = Tree.create(entries)
    const reading = read(typed(tree), entries)
    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    const [buys, sells] = entries.map(group => midnightCommitmentId(group.id))
    expect(reading.creates.map(c => c.id).toSorted(byText)).toEqual([buys, sells].toSorted(byText))
    const buy = reading.creates.find(c => c.id === buys)!
    const sell = reading.creates.find(c => c.id === sells)!
    expect(buy).toMatchObject({
      exposure: 'broadcast',
      cap: 1_000_000n,
      resources: { [`loan:${market.loanToken.toLowerCase()}`]: 1_000_000n }
    })
    expect(sell.resources).toEqual({})
    expect(buy.neutralizer).toEqual(tx(MIDNIGHT, cancel(entries[0]!.id)))
  })

  it('reserves a unit-capped buy at its unit cap, which bounds the loan assets any fill can pay', () => {
    const units = [
      Group.create([
        offer(ECRECOVER, true, 100n, { maxAssets: 0n, maxUnits: 700_000n }),
        offer(ECRECOVER, true, 200n, { maxAssets: 0n, maxUnits: 700_000n })
      ])
    ]
    const reading = read(typed(Tree.create(units)), units)
    expect(reading).toMatchObject({
      ok: true,
      creates: [
        {
          cap: 700_000n,
          resources: { [`loan:${market.loanToken.toLowerCase()}`]: 700_000n }
        }
      ]
    })
  })

  it('reads a publish as exposing every group of the tree and carrying the one signature', async () => {
    const entries = ladder(ECRECOVER)
    const tree = Tree.create(entries)
    const { signature, data } = await signed(tree)
    const reading = read(tx(MEMPOOL, data), entries)
    expect(reading).toMatchObject({ ok: true, carries: [signature.toLowerCase()] })
    if (reading.ok) expect(reading.exposes).toHaveLength(2)
    expect(
      read({ kind: 'release', channel: 'midnight-api', message: { payload: data } }, entries)
    ).toMatchObject({
      ok: true,
      carries: [signature.toLowerCase()]
    })
  })

  it('reads a signature the same from its witness as stored, which SDK instances would not survive', () => {
    const entries = ladder(ECRECOVER)
    const payload = typed(Tree.create(entries))
    const live = read(payload, entries)
    expect(live.ok).toBe(true)
    expect(read(payload, asStored(midnightWitness(entries))?.value)).toEqual(live)
    expect(read(payload, asStored(entries)?.value)).toEqual({
      ok: false,
      reason: 'witness is not an offer tree'
    })
  })

  it.each([undefined, Number.NaN, -1n])('refuses to build with a fee bound of %s', bound => {
    expect(() =>
      midnightOffersValidator({
        chainId: CHAIN,
        maker: maker.address,
        markets: [MARKET_ID],
        maxContinuousFeeCap: bound as bigint
      })
    ).toThrow('maxContinuousFeeCap must be a non-negative bigint')
  })

  it('decodes a payload exactly as the SDK does', async () => {
    const tree = Tree.create(ladder(ECRECOVER))
    const { data } = await signed(tree)
    const ours = decodePayload(data)
    const theirs = await Payload.decode(data)
    expect(typeof ours).not.toBe('string')
    if (typeof ours === 'string') return
    expect(ours.map(i => [i.offer.hash, i.ratifierData])).toEqual(
      theirs.map(i => [Offer.from(i.offer).hash, i.ratifierData])
    )
  })

  it('reads a setter ratification as creating the tree at inclusion, and its publish as revealing nothing', async () => {
    const entries = ladder(SETTER)
    const tree = Tree.create(entries)
    const ratify = tx(
      SETTER,
      encodeFunctionData({
        abi: setterRatifierAbi,
        functionName: 'setIsRootRatified',
        args: [maker.address, tree.root, true]
      })
    )
    const reading = read(ratify, entries)
    expect(reading).toMatchObject({ ok: true })
    if (reading.ok) expect(reading.creates.every(c => c.exposure === 'inclusion')).toBe(true)
    const items = SetterRatifierUtils.ratify({ tree })
    expect(read(tx(MEMPOOL, await Payload.encode(items)), entries)).toMatchObject({
      ok: true,
      exposes: [],
      carries: []
    })
  })

  it('reads a cancellation and a batch of them as retiring their groups', () => {
    const [a, b] = ladder(ECRECOVER).map(group => group.id)
    expect(read(tx(MIDNIGHT, cancel(a!)), undefined)).toMatchObject({
      ok: true,
      retires: [midnightCommitmentId(a!)]
    })
    const batch = encodeFunctionData({
      abi: midnightAbi,
      functionName: 'multicall',
      args: [[cancel(a!), cancel(b!)]]
    })
    expect(read(tx(MIDNIGHT, batch), undefined)).toMatchObject({
      ok: true,
      retires: [a, b].map(g => midnightCommitmentId(g!))
    })
  })

  it('reads a cancel-only group as retiring nothing, and keeps the rest of the batch retiring', () => {
    const [a, b] = ladder(ECRECOVER).map(group => group.id)
    expect(
      read(tx(MIDNIGHT, cancel(a!)), { cancelOnly: [a!.toUpperCase().replace('0X', '0x')] })
    ).toEqual({ ok: true, creates: [], exposes: [], carries: [], retires: [], consumes: {} })
    const batch = encodeFunctionData({
      abi: midnightAbi,
      functionName: 'multicall',
      args: [[cancel(a!), cancel(b!)]]
    })
    expect(read(tx(MIDNIGHT, batch), { cancelOnly: [b!] })).toMatchObject({
      ok: true,
      retires: [midnightCommitmentId(a!)]
    })
  })

  it.each([
    ['a partial amount', () => cancel(ladder(ECRECOVER)[0]!.id, 1n), 'a partial setConsumed'],
    [
      'another maker',
      () => cancel(ladder(ECRECOVER)[0]!.id, MAX_OFFER_CAP, OTHER),
      'cancels on behalf of another maker'
    ]
  ])(
    'keeps a cancel-only group bound to the full amount and the maker: %s',
    (_name, data, reason) => {
      const group = ladder(ECRECOVER)[0]!.id
      const reading = read(tx(MIDNIGHT, data()), { cancelOnly: [group] })
      expect(reading.ok).toBe(false)
      if (!reading.ok) expect(reading.reason).toContain(reason)
    }
  )

  it.each([[{ cancelOnly: 'all' }], [{ cancelOnly: ['0x12'] }], [{}], [null]])(
    'refuses a cancellation witness that is not a list of groups: %j',
    witness => {
      const group = ladder(ECRECOVER)[0]!.id
      expect(read(tx(MIDNIGHT, cancel(group)), witness)).toEqual({
        ok: false,
        reason: 'cancellation witness is not a list of groups'
      })
    }
  )

  it('refuses a cancel-only witness on any target other than Midnight', () => {
    const group = ladder(ECRECOVER)[0]!.id
    expect(read(tx(OTHER, cancel(group)), { cancelOnly: [group] })).toMatchObject({ ok: false })
  })

  it('confirms a cancellation only from the SetConsumed log it promised', () => {
    const [group] = ladder(ECRECOVER).map(g => g.id)
    const payload = tx(MIDNIGHT, cancel(group!))
    const topics = encodeEventTopics({
      abi: [
        {
          type: 'event',
          name: 'SetConsumed',
          inputs: [
            { name: 'caller', type: 'address', indexed: true },
            { name: 'group', type: 'bytes32', indexed: true },
            { name: 'amount', type: 'uint256', indexed: false },
            { name: 'onBehalf', type: 'address', indexed: true }
          ]
        }
      ],
      eventName: 'SetConsumed',
      args: { caller: maker.address, group, onBehalf: maker.address }
    })
    const log = {
      address: MIDNIGHT,
      topics: topics as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [MAX_OFFER_CAP])
    }
    expect(validator.confirm(payload, [log])).toBe(true)
    expect(validator.confirm(payload, [{ ...log, address: OTHER }])).toBe(false)
    expect(validator.confirm(payload, [])).toBe(false)
  })

  describe('refuses what it cannot fully vouch for', () => {
    const entries = ladder(ECRECOVER)
    const tree = Tree.create(entries)

    const alteredOffer = (change: Record<string, unknown>): [KernelPayload, unknown] => {
      const struct = { ...OfferUtils.toStruct({ offer: offer(ECRECOVER, true, 100n) }), ...change }
      const bad = new Offer(struct as ConstructorParameters<typeof Offer>[0])
      const group = new Offer({ ...struct, group: GroupUtils.hash([bad]) } as ConstructorParameters<
        typeof Offer
      >[0])
      return [typed(Tree.create([group])), [group]]
    }

    const refusals: [
      string,
      () => Promise<[KernelPayload, unknown]> | [KernelPayload, unknown],
      string
    ][] = [
      [
        'typed data for another chain',
        () => [{ ...typed(tree), domain: { ...typed(tree).domain, chainId: 1n } }, entries],
        "typed data is not this tree's ratification"
      ],
      [
        'typed data with other types',
        () => [
          { ...typed(tree), types: { OfferTree: [{ name: 'offerTree', type: 'Offer' }] } },
          entries
        ],
        'typed data does not hash'
      ],
      [
        'typed data for another tree',
        () => [typed(Tree.create([offer(ECRECOVER, true, 996n)])), entries],
        "typed data is not this tree's ratification"
      ],
      [
        'an offer for another maker',
        () => {
          const others = [Group.create([offer(ECRECOVER, true, 100n, { maker: OTHER })])]
          return [typed(Tree.create(others)), others]
        },
        'offer maker is not the configured maker'
      ],
      [
        'a market not allowlisted',
        () => {
          const others = [
            Group.create([
              offer(ECRECOVER, true, 100n, { market: { ...market, rcfThreshold: 1n } })
            ])
          ]
          return [typed(Tree.create(others)), others]
        },
        'market not allowlisted'
      ],
      [
        'a sell that is not reduce-only',
        () => {
          const sells = [
            Group.create([
              offer(ECRECOVER, false, 100n, {
                reduceOnly: false,
                receiverIfMakerIsSeller: zeroAddress
              })
            ])
          ]
          return [typed(Tree.create(sells)), sells]
        },
        'sell offer must be reduce-only'
      ],
      [
        'an offer accepting a continuous fee above the configured cap',
        () => {
          const lax = [
            Group.create([offer(ECRECOVER, true, 100n, { continuousFeeCap: MAX_CONTINUOUS_FEE })])
          ]
          return [typed(Tree.create(lax)), lax]
        },
        'offer accepts a continuous fee above the configured cap'
      ],
      [
        'a sell paying its proceeds to someone other than the maker',
        () => {
          const sells = [
            Group.create([offer(ECRECOVER, false, 300n, { receiverIfMakerIsSeller: OTHER })])
          ]
          return [typed(Tree.create(sells)), sells]
        },
        'sell offer must pay the configured maker'
      ],
      [
        'a witness capping both units and assets',
        () => {
          const witness = midnightWitness(entries) as unknown as {
            offers: Record<string, unknown>[]
          }[]
          witness[0]!.offers[0]!.maxUnits = 5n
          return [typed(tree), witness]
        },
        'witness is not an offer tree'
      ],
      [
        'a payload with bytes after its items',
        async () => {
          const { data } = await signed(tree)
          return [tx(MEMPOOL, concat([data, '0xdead'])), entries]
        },
        'payload carries bytes after its items'
      ],
      [
        'a payload that does not decompress',
        () => [tx(MEMPOOL, '0x0100000002abcd'), entries],
        'payload does not decompress'
      ],
      [
        'a payload from another tree',
        async () => {
          const { data } = await signed(Tree.create([offer(ECRECOVER, true, 996n)]))
          return [tx(MEMPOOL, data), entries]
        },
        "payload is not this tree's"
      ],
      [
        'a partial cancellation',
        () => [tx(MIDNIGHT, cancel(entries[0]!.id, 5n)), undefined],
        'a partial setConsumed is not a cancellation'
      ],
      [
        'a cancellation for another maker',
        () => [tx(MIDNIGHT, cancel(entries[0]!.id, MAX_OFFER_CAP, OTHER)), undefined],
        'cancels on behalf of another maker'
      ],
      [
        'a cancellation with trailing calldata',
        () => [tx(MIDNIGHT, concat([cancel(entries[0]!.id), '0x00'])), undefined],
        'only setConsumed cancels'
      ],
      [
        'an empty batch',
        () => [
          tx(
            MIDNIGHT,
            encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [[]] })
          ),
          undefined
        ],
        'empty multicall'
      ],
      [
        'a nested batch',
        () => {
          const inner = encodeFunctionData({
            abi: midnightAbi,
            functionName: 'multicall',
            args: [[cancel(entries[0]!.id)]]
          })
          return [
            tx(
              MIDNIGHT,
              encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [[inner]] })
            ),
            undefined
          ]
        },
        'multicall: only setConsumed cancels'
      ],
      [
        'an unratification',
        () => [
          tx(
            SETTER,
            encodeFunctionData({
              abi: setterRatifierAbi,
              functionName: 'setIsRootRatified',
              args: [maker.address, tree.root, false]
            })
          ),
          entries
        ],
        'unratifying is not modeled'
      ],
      [
        'a ratification for another maker',
        () => [
          tx(
            SETTER,
            encodeFunctionData({
              abi: setterRatifierAbi,
              functionName: 'setIsRootRatified',
              args: [OTHER, tree.root, true]
            })
          ),
          entries
        ],
        'ratifies for another maker'
      ],
      [
        'a ratification of a root the witness does not hash to',
        () => [
          tx(
            SETTER,
            encodeFunctionData({
              abi: setterRatifierAbi,
              functionName: 'setIsRootRatified',
              args: [maker.address, `0x${'11'.repeat(32)}`, true]
            })
          ),
          entries
        ],
        'tree does not hash to the ratified root'
      ],
      [
        'value attached',
        () => [{ ...tx(MIDNIGHT, cancel(entries[0]!.id)), value: 1n }, undefined],
        'nonzero value'
      ],
      [
        'a witness that is not a tree',
        () => [typed(tree), { offers: 'nope' }],
        'witness is not an offer tree'
      ],
      [
        'a ratifier data blob with a second signature appended',
        async () => {
          const { signature } = await signed(tree)
          const items = await EcrecoverRatifierUtils.ratify({
            tree,
            account: maker.address,
            signature
          })
          const smuggled = items.map((item, i) =>
            i === 0 ? { ...item, ratifierData: concat([item.ratifierData, signature]) } : item
          )
          return [tx(MEMPOOL, await Payload.encode(smuggled)), entries]
        },
        'ratifier data is not canonical'
      ],
      [
        'a group that mixes sides or caps, even from a Group the SDK never validated',
        () => {
          const members = [offer(ECRECOVER, false, 100n), offer(ECRECOVER, true, 200n)]
          const id = GroupUtils.hash(members)
          const group = Group.create([offer(ECRECOVER, true, 100n)])
          Object.defineProperty(group, 'offers', {
            value: members.map(o => new Offer({ ...OfferUtils.toStruct({ offer: o }), group: id }))
          })
          return [typed(Tree.create([group])), [group]]
        },
        'offer group mixes sides, reduce-only flags, caps, tokens, or markets'
      ],
      [
        'an unratified payload whose offers name an unknown ratifier',
        async () => {
          const foreign = [offer(OTHER, true, 100n)]
          const data = await Payload.encode(
            Tree.create(foreign).offers.map(o => ({ offer: o, ratifierData: '0x' as Hex }))
          )
          return [tx(MEMPOOL, data), foreign]
        },
        'payload names an unknown ratifier'
      ],
      [
        'an offer that expires after maturity',
        () => alteredOffer({ expiry: market.maturity + 1n }),
        'offer expires after maturity'
      ],
      [
        'an offer that carries callback data',
        () => alteredOffer({ callbackData: '0x01' }),
        'offer has a callback'
      ],
      [
        'an offer that names a callback',
        () => alteredOffer({ callback: OTHER }),
        'offer has a callback'
      ]
    ]

    it.each(refusals)('%s', async (_, make, reason) => {
      const [payload, witness] = await make()
      expect(read(payload, witness)).toEqual({ ok: false, reason })
    })

    it('reads an unratified payload, validated before signing, as revealing nothing', async () => {
      const data = await Payload.encode(
        tree.offers.map(o => ({ offer: o, ratifierData: '0x' as Hex }))
      )
      expect(
        read({ kind: 'release', channel: 'midnight-api', message: { payload: data } }, entries)
      ).toEqual({
        ok: true,
        creates: [],
        exposes: [],
        carries: [],
        retires: [],
        consumes: {}
      })
    })

    it('refuses gzip padded inside its declared length, and a payload over the wire limit', async () => {
      const { data } = await signed(tree)
      const original = hexToBytes(data)
      const padded = new Uint8Array(original.length + 8)
      padded.set(original)
      new DataView(padded.buffer).setUint32(1, padded.length - 5)
      expect(decodePayload(bytesToHex(padded))).toBe(
        'gzip stream does not fill its declared length'
      )
      expect(decodePayload(bytesToHex(new Uint8Array(Payload.MAX_PAYLOAD_BYTES + 1)))).toBe(
        'payload exceeds the wire limit'
      )
    })

    itReadsAsRecorded(
      new URL('readings/midnight-offers.json', import.meta.url),
      validator,
      async () => {
        const at = (payload: KernelPayload, witness?: unknown) => ({ payload, witness, context })
        const { data } = await signed(tree)
        const setterEntries = ladder(SETTER)
        const setterTree = Tree.create(setterEntries)
        const unitCapped = [
          Group.create([
            offer(ECRECOVER, true, 100n, { maxAssets: 0n, maxUnits: 700_000n }),
            offer(ECRECOVER, true, 200n, { maxAssets: 0n, maxUnits: 700_000n })
          ])
        ]
        const [a, b] = entries.map(group => group.id)
        const recorded = {
          'an ecrecover signature': at(typed(tree), entries),
          'an ecrecover signature from a stored witness': at(
            typed(tree),
            asStored(midnightWitness(entries))?.value
          ),
          'a unit-capped buy': at(typed(Tree.create(unitCapped)), unitCapped),
          'a publish to the mempool': at(tx(MEMPOOL, data), entries),
          'a publish to the API': at(
            { kind: 'release', channel: 'midnight-api', message: { payload: data } },
            entries
          ),
          'an unratified publish to the API': at(
            {
              kind: 'release',
              channel: 'midnight-api',
              message: {
                payload: await Payload.encode(
                  tree.offers.map(o => ({ offer: o, ratifierData: '0x' as Hex }))
                )
              }
            },
            entries
          ),
          'a setter ratification': at(
            tx(
              SETTER,
              encodeFunctionData({
                abi: setterRatifierAbi,
                functionName: 'setIsRootRatified',
                args: [maker.address, setterTree.root, true]
              })
            ),
            setterEntries
          ),
          'a setter-ratified publish': at(
            tx(MEMPOOL, await Payload.encode(SetterRatifierUtils.ratify({ tree: setterTree }))),
            setterEntries
          ),
          'a cancellation': at(tx(MIDNIGHT, cancel(a!))),
          'a batch of cancellations': at(
            tx(
              MIDNIGHT,
              encodeFunctionData({
                abi: midnightAbi,
                functionName: 'multicall',
                args: [[cancel(a!), cancel(b!)]]
              })
            )
          ),
          'a release on another channel': at({
            kind: 'release',
            channel: 'elsewhere',
            message: {}
          }),
          'a transaction to the ecrecover ratifier': at(tx(ECRECOVER, '0x'), entries),
          'a transaction to another contract': at(tx(OTHER, cancel(a!))),
          'typed data for the setter ratifier': at(
            { ...typed(tree), domain: { chainId: BigInt(CHAIN), verifyingContract: SETTER } },
            entries
          )
        }
        const refused = await Promise.all(
          refusals.map(async ([name, make]) => {
            const [payload, witness] = await make()
            return [name, at(payload, witness)] as const
          })
        )
        return { ...recorded, ...Object.fromEntries(refused) }
      }
    )

    it('claims only its own targets, its typed-data domain, and its API channel', () => {
      expect(validator.claims(tx(ECRECOVER, '0x'))).toBe(false)
      expect(validator.claims(tx(OTHER, '0x'))).toBe(false)
      expect(
        validator.claims({
          ...typed(tree),
          domain: { chainId: BigInt(CHAIN), verifyingContract: SETTER }
        })
      ).toBe(false)
      expect(validator.claims({ kind: 'release', channel: 'elsewhere', message: {} })).toBe(false)
      expect(validator.claims(tx(MIDNIGHT, '0x'))).toBe(true)
    })
  })
})

describe('opt-in borrowing sell groups', () => {
  const borrowingValidator = midnightOffersValidator({
    chainId: CHAIN,
    maker: maker.address,
    markets: [MARKET_ID],
    debtMarkets: [MARKET_ID],
    maxContinuousFeeCap: FEE_CAP
  })
  const borrow = (ratifier: Address, tick: bigint, extra: Record<string, unknown> = {}) =>
    offer(ratifier, false, tick, { maxAssets: 0n, maxUnits: 700_000n, reduceOnly: false, ...extra })

  it.each([ECRECOVER, SETTER])(
    'reserves face debt once per group through %s ratification',
    ratifier => {
      const group = Group.create([borrow(ratifier, 100n), borrow(ratifier, 200n)])
      const tree = Tree.create([group])
      const payload =
        ratifier === ECRECOVER
          ? typed(tree)
          : tx(
              SETTER,
              encodeFunctionData({
                abi: setterRatifierAbi,
                functionName: 'setIsRootRatified',
                args: [maker.address, tree.root, true]
              })
            )
      expect(borrowingValidator.read(payload, [group], context)).toMatchObject({
        ok: true,
        creates: [
          {
            id: midnightCommitmentId(group.id),
            cap: 700_000n,
            resources: { [`debt:${MARKET_ID.toLowerCase()}`]: 700_000n }
          }
        ]
      })
      expect(read(payload, [group])).toEqual({
        ok: false,
        reason: 'sell offer must be reduce-only'
      })
    }
  )

  it('reads a borrowing sell that expires before maturity', () => {
    const group = Group.create([
      borrow(ECRECOVER, 100n, { expiry: market.maturity - 86_400n }),
      borrow(ECRECOVER, 200n, { expiry: market.maturity - 86_400n })
    ])
    expect(borrowingValidator.read(typed(Tree.create([group])), [group], context)).toMatchObject({
      ok: true,
      creates: [{ id: midnightCommitmentId(group.id), cap: 700_000n }]
    })
  })

  it('rejects a cash-capped borrowing sell', () => {
    const tree = Tree.create([offer(ECRECOVER, false, 100n, { reduceOnly: false })])
    expect(
      borrowingValidator.read(typed(tree), midnightWitness([{ offers: tree.offers }]), context)
    ).toEqual({ ok: false, reason: 'borrowing sell must cap units' })
  })

  it('rejects mixed reduce-only flags even when the first sell reserves no debt', () => {
    const members = [borrow(ECRECOVER, 100n, { reduceOnly: true }), borrow(ECRECOVER, 200n)]
    const id = GroupUtils.hash(members)
    const group = Group.create([members[0]!])
    Object.defineProperty(group, 'offers', {
      value: members.map(o => new Offer({ ...OfferUtils.toStruct({ offer: o }), group: id }))
    })
    const tree = Tree.create([group])
    expect(borrowingValidator.read(typed(tree), [group], context)).toEqual({
      ok: false,
      reason: 'offer group mixes sides, reduce-only flags, caps, tokens, or markets'
    })
  })

  it('rejects a borrowing market outside the market allowlist', () => {
    expect(() =>
      midnightOffersValidator({
        chainId: CHAIN,
        maker: maker.address,
        markets: [],
        debtMarkets: [MARKET_ID],
        maxContinuousFeeCap: FEE_CAP
      })
    ).toThrow('debt market must be allowlisted')
  })
})
