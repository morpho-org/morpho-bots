import type { ValidatorReading, Validator } from '@repo/kernel'
import type { AbiFunction, AbiParameter, Address, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  isAddress,
  isAddressEqual,
  toFunctionSelector
} from 'viem'

const NOTHING: ValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}

const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

const RESOLVE = getAbiItem({ abi: CrossedBooksResolver.abi, name: 'resolve' }) as AbiFunction
const RESOLVE_SELECTOR = toFunctionSelector(RESOLVE)
/** `resolve(CrossedBooksTake[] sellOffers, …)`: a take's first field is its offer, an offer's its market. */
const MARKET = (
  (RESOLVE.inputs[0] as { components: readonly AbiParameter[] }).components[0] as {
    components: readonly AbiParameter[]
  }
).components[0]!

type Take = Readonly<{
  offer: Readonly<{
    market: Readonly<{ chainId: bigint; midnight: Address }>
    buy: boolean
    maker: Address
  }>
  units: bigint
}>

type Context = Readonly<{ midnight: Address; account: Address; chainId: number }>

/** Why a side's takes are not a crossing of `buy` offers on this chain's Midnight, if they are not. */
const sideFault = (takes: readonly Take[], buy: boolean, context: Context) => {
  if (takes.length === 0) return 'a side takes no offer'
  for (const { offer, units } of takes) {
    if (offer.buy !== buy) return 'an offer is taken on the wrong side'
    if (units === 0n) return 'an offer is taken for no units'
    if (offer.market.chainId !== BigInt(context.chainId)) return 'a market is on another chain'
    if (!isAddressEqual(offer.market.midnight, context.midnight))
      return 'a market is on another Midnight'
    if (isAddressEqual(offer.maker, context.account)) return "an offer is the account's own"
  }
  return undefined
}

const unitsOf = (takes: readonly Take[]) => takes.reduce((total, { units }) => total + units, 0n)

const readResolve = (data: Hex, context: Context): ValidatorReading => {
  if (data.slice(0, 10).toLowerCase() !== RESOLVE_SELECTOR) return refuse('not resolve')
  const { args } = decodeFunctionData({ abi: [RESOLVE], data })
  if (encodeFunctionData({ abi: [RESOLVE], args }).toLowerCase() !== data.toLowerCase())
    return refuse('calldata is not canonical')
  const [sells, buys] = args as readonly [readonly Take[], readonly Take[], bigint]
  const fault = sideFault(sells, false, context) ?? sideFault(buys, true, context)
  if (fault) return refuse(fault)
  const market = encodeAbiParameters([MARKET], [sells[0]!.offer.market])
  if (
    [...sells, ...buys].some(
      ({ offer }) => encodeAbiParameters([MARKET], [offer.market]) !== market
    )
  )
    return refuse('takes span more than one market')
  if (unitsOf(sells) !== unitsOf(buys)) return refuse('the sides take unequal units')
  return NOTHING
}

/**
 * Claims every transaction to the crossed-books resolver and reads it as creating no commitment: a
 * zero-value `resolve` crossing sell offers against buy offers, in equal units, of one market on this
 * chain's Midnight, never taking the account's own offer. The resolver takes no allowance from its
 * caller and pays it only the profit, so the account risks only the fee (`SPEC.md`).
 */
export const crossedBooksValidator = (config: {
  resolver: Address
  midnight: Address
}): Validator => ({
  id: 'crossed-books',
  version: 1,
  claims: payload =>
    payload.kind === 'tx' && isAddress(payload.to) && isAddressEqual(payload.to, config.resolver),
  read: (payload, _witness, context) => {
    if (payload.kind !== 'tx') return refuse('only transactions are read')
    if (!isAddress(payload.to) || !isAddressEqual(payload.to, config.resolver))
      return refuse('not the configured resolver')
    if (payload.value !== 0n) return refuse('a resolution carries no value')
    if (!isAddress(context.account)) return refuse('the account is not an address')
    try {
      return readResolve(payload.data as Hex, {
        midnight: config.midnight,
        account: context.account,
        chainId: context.chainId
      })
    } catch {
      return refuse('calldata does not decode')
    }
  },
  confirm: () => true
})
