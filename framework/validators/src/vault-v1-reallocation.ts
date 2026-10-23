import type { ValidatorReading, Validator } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/morpho-ts'
import { metaMorphoAbi } from '@morpho-org/morpho-ts/abis'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  maxUint256,
  size,
  toFunctionSelector
} from 'viem'

/**
 * One market a Vault V1 lists in its withdraw queue, its supply cap, and the vault's assets in it,
 * as the bot read them.
 */
export type VaultV1MarketConfig = Readonly<{ id: Hex; cap: bigint; assets: bigint }>

/** The step witness a reallocation is checked against: the vault's markets at the decision's read. */
export type VaultV1Witness = Readonly<{ markets: readonly VaultV1MarketConfig[] }>

const NOTHING: ValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}

const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

const REALLOCATE = getAbiItem({ abi: metaMorphoAbi, name: 'reallocate' })
const REALLOCATE_SELECTOR = toFunctionSelector(REALLOCATE)
const MARKET_PARAMS = REALLOCATE.inputs[0].components[0]
const ID_BYTES = 32

type Held = Readonly<{ cap: bigint; assets: bigint }>

/** The witness's markets by id, or a refusal reason when it is not a well-formed market list. */
const marketsOf = (witness: unknown): Map<string, Held> | string => {
  const markets = (witness as Partial<VaultV1Witness> | undefined)?.markets
  if (!Array.isArray(markets) || markets.length === 0)
    return 'witness names none of the vault markets'
  const held = new Map<string, Held>()
  for (const market of markets as readonly Partial<VaultV1MarketConfig>[]) {
    const { id, cap, assets } = market ?? {}
    if (
      !isHex(id, { strict: true }) ||
      size(id) !== ID_BYTES ||
      typeof cap !== 'bigint' ||
      cap < 0n ||
      typeof assets !== 'bigint' ||
      assets < 0n
    )
      return 'witness names a malformed market'
    if (held.has(id.toLowerCase())) return 'witness names a market twice'
    held.set(id.toLowerCase(), { cap, assets })
  }
  return held
}

const readReallocate = (data: Hex, markets: ReadonlyMap<string, Held>): ValidatorReading => {
  if (data.slice(0, 10).toLowerCase() !== REALLOCATE_SELECTOR) return refuse('not reallocate')
  const { args } = decodeFunctionData({ abi: [REALLOCATE], data })
  if (encodeFunctionData({ abi: [REALLOCATE], args }).toLowerCase() !== data.toLowerCase())
    return refuse('calldata is not canonical')
  const [allocations] = args
  if (allocations.length === 0) return refuse('reallocate names no market')
  const seen = new Set<string>()
  let withdrawn = 0n
  let supplied = 0n
  for (const [index, { marketParams, assets }] of allocations.entries()) {
    const id = keccak256(encodeAbiParameters([MARKET_PARAMS], [marketParams])).toLowerCase()
    const market = markets.get(id)
    if (market === undefined) return refuse('a market is outside the vault configuration')
    if (seen.has(id)) return refuse('a market is allocated twice')
    seen.add(id)
    if (assets === maxUint256 && index !== allocations.length - 1)
      return refuse('only the last market takes the rest')
    if (assets !== maxUint256 && assets < market.assets) {
      withdrawn += market.assets - assets
      continue
    }
    // `reallocate` supplies the last leg whatever was withdrawn and not yet supplied.
    const deposit =
      assets === maxUint256 ? MathLib.zeroFloorSub(withdrawn, supplied) : assets - market.assets
    // Morpho Vault V1 skips a leg that supplies nothing before it checks the cap:
    // https://github.com/morpho-org/metamorpho/blob/main/src/MetaMorpho.sol (`reallocate`)
    if (deposit === 0n) continue
    if (market.assets + deposit > market.cap) return refuse('a deposit exceeds its market cap')
    supplied += deposit
  }
  return NOTHING
}

/**
 * Claims every transaction to a configured Vault V1 and reads it as creating no commitment: a
 * zero-value `reallocate` that decodes exactly, names only markets in the vault's withdraw queue as
 * the step's {@link VaultV1Witness} reads them, each at most once, with only the last leg taking
 * the rest, and no deposit, the rest included, leaving a market past its cap. `reallocate` moves
 * the vault's own assets between its markets, so nothing the account holds is consumed or
 * committed; the vault itself still enforces roles, caps and balance.
 */
export const vaultV1ReallocationValidator = (config: { vaults: readonly Address[] }): Validator => {
  const configured = (to: string) =>
    isAddress(to) && config.vaults.some(vault => isAddressEqual(vault, to))
  return {
    id: 'vault-v1-reallocation',
    version: 1,
    claims: payload => payload.kind === 'tx' && configured(payload.to),
    read: (payload, witness) => {
      if (payload.kind !== 'tx') return refuse('only transactions are read')
      if (!configured(payload.to)) return refuse('not a configured vault')
      if (payload.value !== 0n) return refuse('a reallocation carries no value')
      const markets = marketsOf(witness)
      if (typeof markets === 'string') return refuse(markets)
      try {
        return readReallocate(payload.data as Hex, markets)
      } catch {
        return refuse('calldata does not decode')
      }
    },
    confirm: () => true
  }
}
