import type { ValidatorReading, Validator } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { SharesMath } from '@morpho-org/blue-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { vaultV2Abi } from '@morpho-org/morpho-ts/abis'
import { marketParamsAbi } from '@morpho-org/morpho-ts/abis/marketParams'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  size,
  toFunctionSelector
} from 'viem'

import { InvalidValidatorConfigError, UnreadableCallError as Unreadable } from './errors'

/**
 * The adapter's supply shares in one Blue Market, by Market id, and the Market's supply totals
 * accrued to the read, which convert those shares to assets as the adapter does.
 */
export type VaultV2Position = Readonly<{
  market: Hex
  shares: bigint
  totalAssets: bigint
  totalShares: bigint
}>

/** One cap id's state as the vault enforces it: its two caps and its stored allocation. */
export type VaultV2Cap = Readonly<{
  id: Hex
  absolute: bigint
  relative: bigint
  allocation: bigint
}>

/**
 * The step witness a reallocation is checked against, as the bot read the vault: its total assets
 * (the relative caps' basis, where a relative cap of exactly WAD means none), every cap id the legs
 * touch, and the adapter's position in each of its Markets.
 */
export type VaultV2Witness = Readonly<{
  totalAssets: bigint
  caps: readonly VaultV2Cap[]
  positions: readonly VaultV2Position[]
}>

const NOTHING: ValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}

const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

const ID_BYTES = 32
const MULTICALL = getAbiItem({ abi: vaultV2Abi, name: 'multicall' })
const ALLOCATE = getAbiItem({ abi: vaultV2Abi, name: 'allocate' })
const DEALLOCATE = getAbiItem({ abi: vaultV2Abi, name: 'deallocate' })
const MULTICALL_SELECTOR = toFunctionSelector(MULTICALL)
const LEG_SELECTORS = new Set<string>([
  toFunctionSelector(ALLOCATE),
  toFunctionSelector(DEALLOCATE)
])

const LEG_ABI = [ALLOCATE, DEALLOCATE] as const

const canonical = (encoded: Hex, data: Hex) => {
  if (encoded.toLowerCase() !== data.toLowerCase())
    throw new Unreadable('calldata is not canonical')
}

const decodeMulticall = (data: Hex): readonly Hex[] => {
  const [calls] = decodeFunctionData({ abi: [MULTICALL], data }).args
  canonical(encodeFunctionData({ abi: [MULTICALL], args: [calls] }), data)
  return calls
}

const decodeLeg = (data: Hex) => {
  const { functionName, args } = decodeFunctionData({ abi: LEG_ABI, data })
  const [adapter, payload, assets] = args
  canonical(
    encodeFunctionData({ abi: LEG_ABI, functionName, args: [adapter, payload, assets] }),
    data
  )
  return { functionName, adapter, data: payload, assets }
}

const marketOf = (data: Hex) => {
  const [params] = decodeAbiParameters([marketParamsAbi], data)
  if (encodeAbiParameters([marketParamsAbi], [params]).toLowerCase() !== data.toLowerCase())
    throw new Unreadable('adapter data is not one market')
  return params
}

/** The three cap ids a Morpho Market V1 adapter reports for one Market, by level. */
export const vaultV2CapIds = (adapter: Address, params: ReturnType<typeof marketOf>) =>
  ({
    adapter: keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['this', adapter])
    ),
    collateral: keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'address' }],
        ['collateralToken', params.collateralToken]
      )
    ),
    market: keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'address' }, marketParamsAbi],
        ['this/marketParams', adapter, params]
      )
    )
  }) as const

type IndexedWitness = Readonly<{
  totalAssets: bigint
  caps: ReadonlyMap<string, VaultV2Cap>
  positions: ReadonlyMap<string, VaultV2Position>
}>

const isId = (id: unknown): id is Hex => isHex(id, { strict: true }) && size(id) === ID_BYTES
const isAmount = (amount: unknown): amount is bigint => typeof amount === 'bigint' && amount >= 0n

/** The witness, indexed, or a refusal reason when it is malformed. */
const indexedWitnessOf = (witness: unknown): IndexedWitness | string => {
  const { totalAssets, caps, positions } = (witness ?? {}) as Partial<VaultV2Witness>
  if (!isAmount(totalAssets) || !Array.isArray(caps) || !Array.isArray(positions))
    return 'witness does not describe the vault'
  const capById = new Map<string, VaultV2Cap>()
  for (const cap of caps as readonly Partial<VaultV2Cap>[]) {
    if (
      !isId(cap?.id) ||
      !isAmount(cap.absolute) ||
      !isAmount(cap.relative) ||
      !isAmount(cap.allocation)
    )
      return 'witness names a malformed cap'
    if (capById.has(cap.id.toLowerCase())) return 'witness names a cap twice'
    capById.set(cap.id.toLowerCase(), cap as VaultV2Cap)
  }
  const byMarket = new Map<string, VaultV2Position>()
  for (const position of positions as readonly Partial<VaultV2Position>[]) {
    if (
      !isId(position?.market) ||
      !isAmount(position.shares) ||
      !isAmount(position.totalAssets) ||
      !isAmount(position.totalShares) ||
      position.shares > position.totalShares
    )
      return 'witness names a malformed position'
    if (byMarket.has(position.market.toLowerCase())) return 'witness names a position twice'
    byMarket.set(position.market.toLowerCase(), position as VaultV2Position)
  }
  return { totalAssets, caps: capById, positions: byMarket }
}

/** What the legs replayed so far left: each cap id's allocation and each market's position. */
type Replay = Readonly<{
  allocations: Map<string, bigint>
  positions: Map<string, VaultV2Position>
}>

/**
 * The adapter's position after one leg, as Blue's `supply`/`withdraw` mint and burn shares and the
 * adapter's `expectedSupplyAssets` converts them back (both generations of the Market V1 adapter),
 * or a refusal reason for a leg Blue or the adapter would revert.
 * https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/SharesMathLib.sol
 */
const moved = (
  position: VaultV2Position,
  allocate: boolean,
  assets: bigint
): Readonly<{ position: VaultV2Position; assets: bigint }> | string => {
  const { shares, totalAssets, totalShares } = position
  const delta = SharesMath.toShares(assets, totalAssets, totalShares, allocate ? 'Down' : 'Up')
  if (allocate && delta < assets) return 'an allocation mints fewer shares than assets'
  if (!allocate && (delta > shares || assets > totalAssets))
    return 'a deallocation exceeds its position'
  const next = allocate
    ? {
        shares: shares + delta,
        totalAssets: totalAssets + assets,
        totalShares: totalShares + delta
      }
    : {
        shares: shares - delta,
        totalAssets: totalAssets - assets,
        totalShares: totalShares - delta
      }
  return {
    position: { ...position, ...next },
    assets: SharesMath.toAssets(next.shares, next.totalAssets, next.totalShares, 'Down')
  }
}

/**
 * Applies one leg as VaultV2 does: the leg moves the adapter's position in its market, and every one
 * of the market's three cap ids moves by the change from that market's stored allocation; an
 * allocation must then fit each id's absolute and relative cap. Returns a refusal reason, if any.
 */
const applyLeg = (
  leg: ReturnType<typeof decodeLeg>,
  adapter: Address,
  witness: IndexedWitness,
  { allocations, positions }: Replay
): string | undefined => {
  const params = marketOf(leg.data)
  const market = keccak256(encodeAbiParameters([marketParamsAbi], [params])).toLowerCase()
  const held = positions.get(market)
  if (held === undefined) return 'a market is outside the adapter configuration'
  const allocate = leg.functionName === 'allocate'
  const result = moved(held, allocate, leg.assets)
  if (typeof result === 'string') return result
  positions.set(market, result.position)
  const after = result.assets
  const ids = vaultV2CapIds(adapter, params)
  const stored = allocations.get(ids.market.toLowerCase())
  if (stored === undefined) return 'witness does not name a cap the leg moves'
  for (const [level, id] of Object.entries(ids)) {
    const cap = witness.caps.get(id.toLowerCase())
    const allocation = allocations.get(id.toLowerCase())
    if (cap === undefined || allocation === undefined)
      return 'witness does not name a cap the leg moves'
    const next = allocation + after - stored
    if (next < 0n) return `the ${level} allocation underflows`
    allocations.set(id.toLowerCase(), next)
    if (!allocate) continue
    if (next > cap.absolute) return `an allocation breaches its ${level} absolute cap`
    if (
      cap.relative !== MathLib.WAD &&
      next > MathLib.mulDivDown(witness.totalAssets, cap.relative, MathLib.WAD)
    )
      return `an allocation breaches its ${level} relative cap`
  }
  return undefined
}

/** Replays the legs, deallocations first, against the vault as the witness reads it. */
const readLegs = (
  calls: readonly Hex[],
  adapter: Address,
  witness: IndexedWitness
): ValidatorReading => {
  if (calls.length === 0) return refuse('multicall carries no leg')
  const replay: Replay = {
    allocations: new Map([...witness.caps].map(([id, cap]) => [id, cap.allocation])),
    positions: new Map(witness.positions)
  }
  let allocating = false
  for (const call of calls) {
    if (!LEG_SELECTORS.has(call.slice(0, 10).toLowerCase()))
      return refuse('an inner call is not allocate or deallocate')
    const leg = decodeLeg(call)
    if (!isAddressEqual(leg.adapter, adapter)) return refuse('a leg names an unknown adapter')
    if (leg.assets === 0n) return refuse('a leg moves nothing')
    if (leg.functionName === 'deallocate' && allocating)
      return refuse('a deallocation follows an allocation')
    allocating ||= leg.functionName === 'allocate'
    const refusal = applyLeg(leg, adapter, witness, replay)
    if (refusal !== undefined) return refuse(refusal)
  }
  return NOTHING
}

/**
 * Claims every transaction to a configured VaultV2 and reads it as creating no commitment: a
 * zero-value `multicall` that decodes exactly into `deallocate` legs then `allocate` legs, each
 * naming the vault's configured adapter and one market the adapter holds, that keeps every
 * allocation within its market, collateral and adapter caps as the step's {@link VaultV2Witness}
 * reads them. Reallocation moves the vault's own assets, so nothing the account holds is consumed or
 * committed; the vault itself still enforces roles and caps against its live state.
 */
export const vaultV2ReallocationValidator = (config: {
  /** Each whitelisted vault's one Morpho Market V1 adapter. */
  adapters: Readonly<Record<Address, Address>>
}): Validator => {
  const configured: { vault: Address; adapter: Address }[] = []
  for (const [vault, adapter] of Object.entries(config.adapters)) {
    if (!isAddress(vault) || !isAddress(adapter))
      throw new InvalidValidatorConfigError('a vault or adapter is not an address')
    if (configured.some(entry => isAddressEqual(entry.vault, vault)))
      throw new InvalidValidatorConfigError('a vault is configured twice')
    configured.push({ vault: getAddress(vault), adapter: getAddress(adapter) })
  }
  const adapterOf = (to: string) =>
    isAddress(to) ? configured.find(entry => isAddressEqual(entry.vault, to))?.adapter : undefined
  return {
    id: 'vault-v2-reallocation',
    version: 1,
    claims: payload => payload.kind === 'tx' && adapterOf(payload.to) !== undefined,
    read: (payload, witness) => {
      if (payload.kind !== 'tx') return refuse('only transactions are read')
      const adapter = adapterOf(payload.to)
      if (adapter === undefined) return refuse('not a configured vault')
      if (payload.value !== 0n) return refuse('a reallocation carries no value')
      const indexed = indexedWitnessOf(witness)
      if (typeof indexed === 'string') return refuse(indexed)
      const data = payload.data as Hex
      if (data.slice(0, 10).toLowerCase() !== MULTICALL_SELECTOR) return refuse('not multicall')
      try {
        return readLegs(decodeMulticall(data), adapter, indexed)
      } catch (error) {
        return refuse(error instanceof Unreadable ? error.message : 'calldata does not decode')
      }
    },
    confirm: () => true
  }
}
