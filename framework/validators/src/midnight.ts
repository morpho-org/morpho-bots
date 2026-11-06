import type {
  Group,
  Market,
  MarketParams,
  TreeCreateParams,
  TreeProof
} from '@morpho-org/midnight-sdk'
import type {
  CommitmentSpec,
  Exposure,
  Log,
  Payload,
  ValidatorReading,
  TxPayload,
  TypedPayload,
  Validator
} from '@repo/kernel'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  GroupUtils,
  MarketUtils,
  MAX_OFFER_CAP,
  MAX_TICK,
  midnightAbi,
  type Offer,
  OfferUtils,
  SetterRatifierUtils,
  setterRatifierAbi,
  Tree,
  TreeUtils
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  serializeSignature,
  size,
  zeroAddress
} from 'viem'

import { decodePayload, type PayloadItem } from './midnight-payload'

/** The API channel a signed tree is posted to for mempool validation, revealing its signature. */
const MIDNIGHT_API_CHANNEL = 'midnight-api'

const events = parseAbi([
  'event SetConsumed(address indexed caller, bytes32 indexed group, uint256 amount, address indexed onBehalf)',
  'event SetIsRootRatified(address indexed caller, address indexed maker, bytes32 indexed root, bool newIsRootRatified)'
])

export const midnightCommitmentId = (group: Hex) => `midnight:${group.toLowerCase()}`

/** An offer tree's groups as plain data: the witness form a kernel stores and this validator reads back. */
export const midnightWitness = (groups: readonly Pick<Group, 'offers'>[]): TreeCreateParams =>
  groups.map(group => ({ offers: structuredClone(group.offers) }))

type Options = {
  chainId: number
  /** The maker whose offers this kernel exposes; with an authorized signer it is not the signing account. */
  maker: Address
  /** Market ids (`MarketUtils.toId`) offers may name; any other market is refused. */
  markets: readonly Hex[]
  /** The highest market continuous fee an offer may accept. */
  maxContinuousFeeCap: bigint
  /** Markets whose units-capped sells may borrow against manually supplied loan-token collateral. */
  debtMarkets?: readonly Hex[]
}

const NOTHING = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
} as const
const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

const addressOf = (
  chainId: number,
  key: 'midnight' | 'midnightMempool' | 'ecrecoverRatifier' | 'setterRatifier'
) => {
  const address = getChainAddress(chainId, key)
  if (!address) throw new Error(`no ${key} address for chain ${chainId}`)
  return address
}

const paramsOf = (market: MarketParams | Market) => ('params' in market ? market.params : market)

const same = (a: string, b: string) =>
  isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && isAddressEqual(a, b)

/** The proof an item's ratifier data carries, and the signature an ecrecover one reveals. */
const proofOf = (
  ratifierData: Hex,
  ecrecovered: boolean
): { proof: TreeProof; signature?: string } | string => {
  const canonical = (encoded: Hex) => encoded.toLowerCase() === ratifierData.toLowerCase()
  try {
    if (!ecrecovered) {
      const proof = SetterRatifierUtils.decodeRatifierData(ratifierData)
      return canonical(SetterRatifierUtils.encodeRatifierData(proof))
        ? { proof }
        : 'ratifier data is not canonical'
    }
    const decoded = EcrecoverRatifierUtils.decodeRatifierData(ratifierData)
    if (!canonical(EcrecoverRatifierUtils.encodeRatifierData(decoded)))
      return 'ratifier data is not canonical'
    const { r, s, v } = decoded.signature
    if (v !== 27 && v !== 28) return 'signature has an invalid v'
    return {
      proof: decoded,
      signature: serializeSignature({ r, s, yParity: v - 27 }).toLowerCase()
    }
  } catch {
    return 'ratifier data does not decode'
  }
}

/**
 * The groups a cancellation's witness names as held by no kernel commitment. Cancelling one retires
 * nothing: it is still a full `setConsumed` on behalf of the maker, so it can only remove exposure.
 */
const cancelOnlyOf = (witness: unknown): ReadonlySet<string> | string => {
  if (witness === undefined) return new Set()
  const groups = (witness as { cancelOnly?: unknown } | null)?.cancelOnly
  if (!Array.isArray(groups) || !groups.every(group => isHex(group) && size(group) === 32))
    return 'cancellation witness is not a list of groups'
  return new Set(groups.map(group => (group as Hex).toLowerCase()))
}

/**
 * The production Midnight offers validator: it decodes every quoter action with the Midnight SDK
 * and ABIs and refuses anything it cannot fully decode. Commitments are consumption groups; a buy
 * reserves its loan token up to the group's cap; an opted-in borrowing sell reserves face debt in
 * its market up to its units cap, and a reduce-only sell reserves nothing.
 */
export const midnightOffersValidator = (options: Options): Validator => {
  const { chainId, maker } = options
  if (typeof options.maxContinuousFeeCap !== 'bigint' || options.maxContinuousFeeCap < 0n)
    throw new TypeError('maxContinuousFeeCap must be a non-negative bigint')
  const midnight = addressOf(chainId, 'midnight')
  const mempool = addressOf(chainId, 'midnightMempool')
  const ecrecover = addressOf(chainId, 'ecrecoverRatifier')
  const setter = addressOf(chainId, 'setterRatifier')
  const markets = new Set(options.markets.map(id => id.toLowerCase()))
  const debtMarkets = new Set(options.debtMarkets?.map(id => id.toLowerCase()))
  if ([...debtMarkets].some(id => !markets.has(id)))
    throw new TypeError('debt market must be allowlisted')

  const cancel = (group: Hex): TxPayload => ({
    kind: 'tx',
    to: midnight,
    data: encodeFunctionData({
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [group, MAX_OFFER_CAP, maker]
    }),
    value: 0n
  })

  const offerRefusal = (offer: Offer, ratifier: Address): string | undefined => {
    const market = paramsOf(offer.market)
    if (!same(offer.maker, maker)) return 'offer maker is not the configured maker'
    if (!same(offer.ratifier, ratifier))
      return 'offer ratifier does not match the ratification path'
    if (Number(market.chainId) !== chainId) return 'offer is for another chain'
    if (!same(market.midnight, midnight)) return 'offer names another Midnight'
    if (!markets.has(MarketUtils.toId(offer.market).toLowerCase())) return 'market not allowlisted'
    if ((offer.maxUnits === 0n) === (offer.maxAssets === 0n))
      return 'offer must cap exactly one of units or assets'
    if (!same(offer.callback, zeroAddress) || offer.callbackData !== '0x')
      return 'offer has a callback'
    if (offer.tick > MAX_TICK) return 'offer tick out of range'
    if (offer.continuousFeeCap > options.maxContinuousFeeCap)
      return 'offer accepts a continuous fee above the configured cap'
    if (offer.expiry > market.maturity) return 'offer expires after maturity'
    try {
      OfferUtils.validateOfferTimeRange({ start: offer.start, expiry: offer.expiry })
    } catch {
      return 'offer time range is invalid'
    }
    if (offer.buy) {
      return offer.reduceOnly || !same(offer.receiverIfMakerIsSeller, zeroAddress)
        ? 'buy offer must not be reduce-only or name a seller receiver'
        : undefined
    }
    if (!offer.reduceOnly) {
      if (!debtMarkets.has(MarketUtils.toId(offer.market).toLowerCase()))
        return 'sell offer must be reduce-only'
      if (offer.maxUnits === 0n) return 'borrowing sell must cap units'
    }
    return same(offer.receiverIfMakerIsSeller, maker)
      ? undefined
      : 'sell offer must pay the configured maker'
  }

  /** One commitment per consumption group, its id recomputed from the offers that share it. */
  const commitments = (
    offers: readonly Offer[],
    ratifier: Address,
    exposure: Exposure
  ): CommitmentSpec[] | string => {
    const byGroup = new Map<Hex, Offer[]>()
    for (const offer of offers) {
      const refusal = offerRefusal(offer, ratifier)
      if (refusal) return refusal
      const group = offer.group.toLowerCase() as Hex
      byGroup.set(group, [...(byGroup.get(group) ?? []), offer])
    }
    const specs: CommitmentSpec[] = []
    for (const [group, members] of byGroup) {
      const first = members[0]!
      const shape = (o: Offer) =>
        [
          o.buy,
          o.reduceOnly,
          o.maxUnits,
          o.maxAssets,
          paramsOf(o.market).loanToken.toLowerCase(),
          MarketUtils.toId(o.market)
        ].join()
      if (members.some(o => shape(o) !== shape(first)))
        return 'offer group mixes sides, reduce-only flags, caps, tokens, or markets'
      if (GroupUtils.hash(members).toLowerCase() !== group)
        return 'offer group does not hash to its offers'
      // A unit pays at most one loan asset, since every tick prices below 1e18:
      // https://github.com/morpho-org/midnight/blob/main/src/libraries/TickLib.sol (tickToPrice)
      const cap = first.maxUnits === 0n ? first.maxAssets : first.maxUnits
      specs.push({
        id: midnightCommitmentId(group),
        exposure,
        resources: first.buy
          ? { [`loan:${paramsOf(first.market).loanToken.toLowerCase()}`]: cap }
          : first.reduceOnly
            ? {}
            : { [`debt:${MarketUtils.toId(first.market).toLowerCase()}`]: cap },
        cap,
        expiry: members.reduce((max, o) => (o.expiry > max ? o.expiry : max), 0n),
        neutralizer: cancel(group)
      })
    }
    return specs
  }

  const treeOf = (witness: unknown): Tree | string => {
    try {
      return Tree.create(witness as TreeCreateParams)
    } catch {
      return 'witness is not an offer tree'
    }
  }

  const creating = (tree: Tree, ratifier: Address, exposure: Exposure): ValidatorReading => {
    const creates = commitments(tree.offers, ratifier, exposure)
    return typeof creates === 'string' ? refuse(creates) : { ...NOTHING, creates }
  }

  const readTyped = (payload: TypedPayload, witness: unknown): ValidatorReading => {
    const tree = treeOf(witness)
    if (typeof tree === 'string') return refuse(tree)
    let signed: Hex
    try {
      signed = hashTypedData(payload as Parameters<typeof hashTypedData>[0])
    } catch {
      return refuse('typed data does not hash')
    }
    if (signed !== EcrecoverRatifierUtils.digest({ tree, chainId }))
      return refuse("typed data is not this tree's ratification")
    return creating(tree, ecrecover, 'broadcast')
  }

  /** Validated before signing, a payload carries no ratifier data and reveals nothing; its offers must still be the tree's. */
  const unsigned = (
    items: readonly PayloadItem[],
    tree: Tree,
    ratifier: Address
  ): ValidatorReading => {
    const leaves = new Set(tree.offers.map(o => o.hash.toLowerCase()))
    if (items.some(item => !leaves.has(item.offer.hash.toLowerCase())))
      return refuse('payload offer is not a leaf of the tree')
    const groups = commitments(tree.offers, ratifier, 'broadcast')
    return typeof groups === 'string' ? refuse(groups) : NOTHING
  }

  /**
   * A payload is the tree's own leaves, each proven to its root. An ecrecover signature ratifies
   * every leaf of the tree, so carrying it exposes every group of the tree, published or not.
   */
  const carrying = (items: readonly PayloadItem[], witness: unknown): ValidatorReading => {
    const tree = treeOf(witness)
    if (typeof tree === 'string') return refuse(tree)
    const ratifier = items[0]!.offer.ratifier
    const ecrecovered = same(ratifier, ecrecover)
    if (!ecrecovered && !same(ratifier, setter)) return refuse('payload names an unknown ratifier')
    const unratified = items.filter(item => item.ratifierData === '0x').length
    if (unratified === items.length) return unsigned(items, tree, ratifier)
    if (unratified > 0) return refuse('payload mixes ratified and unratified items')
    const signatures = new Set<string>()
    for (const { offer, ratifierData } of items) {
      if (!same(offer.ratifier, ratifier)) return refuse('payload mixes ratifiers')
      const decoded = proofOf(ratifierData, ecrecovered)
      if (typeof decoded === 'string') return refuse(decoded)
      const { proof, signature } = decoded
      if (signature) signatures.add(signature)
      if (proof.root.toLowerCase() !== tree.root.toLowerCase())
        return refuse("payload is not this tree's")
      if (
        !TreeUtils.verifyProof({
          offer,
          root: tree.root,
          leafIndex: proof.leafIndex,
          proof: proof.proof
        })
      )
        return refuse('payload offer is not a leaf of the tree')
    }
    const groups = commitments(tree.offers, ratifier, ecrecovered ? 'broadcast' : 'inclusion')
    if (typeof groups === 'string') return refuse(groups)
    if (!ecrecovered) return NOTHING
    if (signatures.size !== 1) return refuse('payload carries more than one signature')
    return { ...NOTHING, exposes: groups.map(g => g.id), carries: [...signatures] }
  }

  const strictCall = <abi extends typeof midnightAbi | typeof setterRatifierAbi>(
    abi: abi,
    data: Hex
  ) => {
    try {
      const decoded = decodeFunctionData({ abi, data })
      const reencoded = encodeFunctionData({ abi, ...decoded } as Parameters<
        typeof encodeFunctionData
      >[0])
      return reencoded.toLowerCase() === data.toLowerCase() ? decoded : undefined
    } catch {
      return undefined
    }
  }

  const cancelled = (data: Hex): { group: Hex } | { refusal: string } => {
    const call = strictCall(midnightAbi, data)
    if (call?.functionName !== 'setConsumed') return { refusal: 'only setConsumed cancels' }
    const [group, amount, onBehalf] = call.args as readonly [Hex, bigint, Address]
    if (amount !== MAX_OFFER_CAP) return { refusal: 'a partial setConsumed is not a cancellation' }
    if (!same(onBehalf, maker)) return { refusal: 'cancels on behalf of another maker' }
    return { group }
  }

  const readTx = (payload: TxPayload, witness: unknown): ValidatorReading => {
    if (payload.value !== 0n) return refuse('nonzero value')
    const data = payload.data as Hex
    if (same(payload.to, mempool)) {
      const items = decodePayload(data)
      return typeof items === 'string' ? refuse(items) : carrying(items, witness)
    }
    if (same(payload.to, setter)) {
      const call = strictCall(setterRatifierAbi, data)
      if (call?.functionName !== 'setIsRootRatified')
        return refuse('only setIsRootRatified is recognized')
      const [ratifiedFor, root, ratified] = call.args as readonly [Address, Hex, boolean]
      if (!same(ratifiedFor, maker)) return refuse('ratifies for another maker')
      if (!ratified) return refuse('unratifying is not modeled')
      const tree = treeOf(witness)
      if (typeof tree === 'string') return refuse(tree)
      if (root.toLowerCase() !== tree.root.toLowerCase())
        return refuse('tree does not hash to the ratified root')
      return creating(tree, setter, 'inclusion')
    }
    if (same(payload.to, midnight)) {
      const unheld = cancelOnlyOf(witness)
      if (typeof unheld === 'string') return refuse(unheld)
      const retiring = (groups: readonly Hex[]): ValidatorReading => ({
        ...NOTHING,
        retires: groups.filter(group => !unheld.has(group.toLowerCase())).map(midnightCommitmentId)
      })
      const single = cancelled(data)
      if ('group' in single) return retiring([single.group])
      const batch = strictCall(midnightAbi, data)
      if (batch?.functionName !== 'multicall') return refuse(single.refusal)
      const [calls] = batch.args as readonly [readonly Hex[]]
      if (calls.length === 0) return refuse('empty multicall')
      const groups: Hex[] = []
      for (const call of calls) {
        const inner = cancelled(call)
        if (!('group' in inner)) return refuse(`multicall: ${inner.refusal}`)
        groups.push(inner.group)
      }
      return retiring(groups)
    }
    return refuse('unrecognized target')
  }

  const read = (payload: Payload, witness: unknown): ValidatorReading => {
    if (payload.kind === 'typed') return readTyped(payload, witness)
    if (payload.kind === 'tx') return readTx(payload, witness)
    const posted = payload.message.payload
    if (typeof posted !== 'string') return refuse('release carries no payload')
    const items = decodePayload(posted as Hex)
    return typeof items === 'string' ? refuse(items) : carrying(items, witness)
  }

  const logged = (
    logs: readonly Log[],
    address: Address,
    matches: (event: ReturnType<typeof decode>) => boolean
  ) => logs.some(log => same(log.address, address) && matches(decode(log)))

  const decode = (log: Log) => {
    try {
      return decodeEventLog({
        abi: events,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex
      })
    } catch {
      return undefined
    }
  }

  const confirm = (payload: TxPayload, logs: readonly Log[]) => {
    const reading = readTx(payload, undefined)
    if (same(payload.to, setter)) {
      const call = strictCall(setterRatifierAbi, payload.data as Hex)
      if (call?.functionName !== 'setIsRootRatified') return false
      const [, root] = call.args as readonly [Address, Hex, boolean]
      return logged(
        logs,
        setter,
        event =>
          event?.eventName === 'SetIsRootRatified' &&
          same(event.args.maker, maker) &&
          event.args.root.toLowerCase() === root.toLowerCase() &&
          event.args.newIsRootRatified
      )
    }
    if (same(payload.to, midnight) && reading.ok)
      return reading.retires.every(id =>
        logged(
          logs,
          midnight,
          event =>
            event?.eventName === 'SetConsumed' &&
            same(event.args.onBehalf, maker) &&
            midnightCommitmentId(event.args.group) === id &&
            event.args.amount === MAX_OFFER_CAP
        )
      )
    return true
  }

  return {
    id: 'midnight-offers',
    version: 2,
    claims: payload =>
      payload.kind === 'typed'
        ? same(payload.domain.verifyingContract ?? '', ecrecover)
        : payload.kind === 'release'
          ? payload.channel === MIDNIGHT_API_CHANNEL
          : [midnight, mempool, setter].some(target => same(payload.to, target)),
    read: (payload, witness) => {
      try {
        return read(payload, witness)
      } catch {
        return refuse('validator threw')
      }
    },
    confirm
  }
}
