import type {
  CommitmentSpec,
  Log,
  OkValidatorReading,
  Payload,
  ValidatorReading,
  TxPayload,
  Validator,
  ValidatorContext
} from '../src'

import { decodeCall, encodeCall } from './codec'

/** `type(uint128).max`: `setConsumed` with it cancels every offer in the group and never reverts. */
export const MAX_UINT128 = (1n << 128n) - 1n

/**
 * A symbolic stand-in for one Midnight offer, carrying the `IOffer` fields exposure depends on. The
 * reference never encodes real calldata; the production validator decodes `Payload.decode` items and
 * the EIP-712 `OfferTree` root with `@morpho-org/midnight-sdk`.
 */
export type ModelOffer = {
  group: string
  buy: boolean
  maxAssets: bigint
  expiry: bigint
  marketId: string
  loanToken: string
  maker: string
  ratifier: string
}
export type ModelTree = { offers: readonly ModelOffer[] }

export const treeRoot = (tree: ModelTree): string =>
  `root(${tree.offers
    .map(
      o =>
        `${o.group}|${o.buy}|${o.maxAssets}|${o.expiry}|${o.marketId}|${o.loanToken}|${o.maker}|${o.ratifier}`
    )
    .join(',')})`

export const midnightId = (group: string) => `midnight:${group}`

/** A receipt log in the model: the event name and its subject stand in for topics. */
export const modelLog = (address: string, event: string, subject: string): Log => ({
  address,
  topics: [event, subject],
  data: '0x'
})

const hasLog = (logs: readonly Log[], event: string, subject: string) =>
  logs.some(log => log.topics[0] === event && log.topics[1] === subject)

/** The only types an offer-tree signature may carry in this model; production compares the SDK's own. */
export const OFFER_TREE_TYPES = { OfferTree: [{ name: 'root', type: 'bytes32' }] } as const

const NOTHING: OkValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}
const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

const maxOf = (values: readonly bigint[]) => values.reduce((a, b) => (b > a ? b : a), 0n)

type MidnightValidatorConfig = {
  midnight: string
  mempool: string
  ecrecoverRatifier: string
  setterRatifier: string
  markets: readonly string[]
}

/**
 * The Midnight-offers validator: a commitment per consumption group, sized by the largest cap any
 * offer in the group carries (the contract checks each offer's cap against the shared `consumed`).
 */
export const midnightOffersValidator = (config: MidnightValidatorConfig): Validator => {
  const targets = [config.midnight, config.mempool, config.setterRatifier, config.ecrecoverRatifier]

  const groupsOf = (
    tree: ModelTree,
    account: string,
    ratifier: string,
    exposure: CommitmentSpec['exposure']
  ): CommitmentSpec[] | string => {
    if (tree.offers.length === 0) return 'empty tree'
    const byGroup = new Map<string, ModelOffer[]>()
    for (const offer of tree.offers) {
      if (offer.maker !== account) return 'offer maker is not the kernel account'
      if (offer.ratifier !== ratifier) return 'offer ratifier does not match the ratification path'
      if (!config.markets.includes(offer.marketId))
        return `market ${offer.marketId} not allowlisted`
      if (offer.maxAssets <= 0n) return 'offer cap must be positive'
      byGroup.set(offer.group, [...(byGroup.get(offer.group) ?? []), offer])
    }
    return [...byGroup].map(([group, offers]) => {
      const resources: Record<string, bigint> = {}
      for (const offer of offers) {
        const key = offer.buy ? `loan:${offer.loanToken}` : `debt:${offer.marketId}`
        resources[key] = maxOf([resources[key] ?? 0n, offer.maxAssets])
      }
      return {
        id: midnightId(group),
        exposure,
        resources,
        cap: maxOf(offers.map(o => o.maxAssets)),
        expiry: maxOf(offers.map(o => o.expiry)),
        neutralizer: encodeCall(config.midnight, 'setConsumed', {
          group,
          amount: MAX_UINT128,
          onBehalf: account
        })
      }
    })
  }

  const boundTree = (witness: unknown, root: unknown): ModelTree | string => {
    const tree = witness as ModelTree | undefined
    if (!tree || !Array.isArray(tree.offers)) return 'missing tree preimage'
    if (typeof root !== 'string' || treeRoot(tree) !== root)
      return 'tree preimage does not hash to root'
    return tree
  }

  const creating = (
    witness: unknown,
    root: unknown,
    account: string,
    ratifier: string,
    exposure: CommitmentSpec['exposure']
  ): ValidatorReading => {
    const tree = boundTree(witness, root)
    if (typeof tree === 'string') return refuse(tree)
    const creates = groupsOf(tree, account, ratifier, exposure)
    return typeof creates === 'string' ? refuse(creates) : { ...NOTHING, creates }
  }

  /** A carrier reveals a signature: to the mempool contract in calldata, or to the API in a request. */
  const carrying = (
    message: Readonly<Record<string, unknown>>,
    witness: unknown,
    account: string
  ): ValidatorReading => {
    const tree = boundTree(witness, message.root)
    if (typeof tree === 'string') return refuse(tree)
    const signature = message.signature
    if (signature === undefined) return NOTHING
    if (typeof signature !== 'string') return refuse('malformed signature')
    const groups = groupsOf(tree, account, config.ecrecoverRatifier, 'broadcast')
    if (typeof groups === 'string') return refuse(groups)
    return { ...NOTHING, exposes: groups.map(g => g.id), carries: [signature] }
  }

  const readTx = (payload: TxPayload, witness: unknown, account: string): ValidatorReading => {
    if (payload.value !== 0n) return refuse('nonzero value')
    const call = decodeCall(payload)
    if (!call) return refuse('calldata does not decode')
    const { fn, args } = call
    if (payload.to === config.mempool && fn === 'publish') return carrying(args, witness, account)
    if (payload.to === config.setterRatifier && fn === 'setIsRootRatified') {
      if (args.maker !== account) return refuse('ratifies for another maker')
      if (args.newIsRootRatified !== true) return refuse('unratify is not modeled')
      return creating(witness, args.root, account, config.setterRatifier, 'inclusion')
    }
    if (payload.to === config.midnight && fn === 'setConsumed') {
      if (args.onBehalf !== account) return refuse('consumes on behalf of another maker')
      if (args.amount !== MAX_UINT128) return refuse('partial setConsumed is not a neutralizer')
      if (typeof args.group !== 'string') return refuse('malformed group')
      return { ...NOTHING, retires: [midnightId(args.group)] }
    }
    return refuse(`unrecognized ${payload.to}.${fn}`)
  }

  const read = (
    payload: Payload,
    witness: unknown,
    context: ValidatorContext
  ): ValidatorReading => {
    const { account, chainId } = context
    if (payload.kind === 'release') return carrying(payload.message, witness, account)
    if (payload.kind === 'tx') return readTx(payload, witness, account)
    if (payload.primaryType !== 'OfferTree') return refuse('unrecognized typed data')
    if (payload.domain.chainId !== BigInt(chainId)) return refuse('typed data for another chain')
    const domainKeys = Object.keys(payload.domain).toSorted().join()
    if (domainKeys !== 'chainId,verifyingContract') return refuse('unexpected typed data domain')
    if (JSON.stringify(payload.types) !== JSON.stringify(OFFER_TREE_TYPES))
      return refuse('unexpected typed data types')
    return creating(witness, payload.message.root, account, config.ecrecoverRatifier, 'broadcast')
  }

  return {
    id: 'midnight-offers',
    version: 1,
    claims: payload =>
      payload.kind === 'typed'
        ? payload.domain.verifyingContract === config.ecrecoverRatifier
        : payload.kind === 'release'
          ? payload.channel === 'midnight-api'
          : targets.includes(payload.to),
    read: (payload, witness, context) => {
      try {
        return read(payload, witness, context)
      } catch {
        return refuse('validator threw')
      }
    },
    confirm: (payload: TxPayload, logs) => {
      const call = decodeCall(payload)
      if (call?.fn === 'setIsRootRatified')
        return hasLog(logs, 'SetIsRootRatified', String(call.args.root))
      if (call?.fn === 'setConsumed') return hasLog(logs, 'SetConsumed', String(call.args.group))
      return true
    }
  }
}

/**
 * For a liquidator on the generic Executor: nothing it signs outlives its transaction. It claims only
 * the Executor, so typed data and any other target stay unclaimed and are refused.
 */
export const noCommitmentsValidator = (executor: string): Validator => ({
  id: 'no-commitments',
  version: 1,
  claims: payload => payload.kind === 'tx' && payload.to === executor,
  read: payload =>
    payload.kind === 'tx' && decodeCall(payload)?.fn === 'exec' && payload.value === 0n
      ? NOTHING
      : refuse('only Executor.exec is recognized'),
  confirm: () => true
})
