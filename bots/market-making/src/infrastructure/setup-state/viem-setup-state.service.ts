import type { Address, Hex } from 'viem'

import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  parseAbi,
  zeroAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { BookSetup, SetupStateService } from '../../application/setup-check.service'

import { SafeProviderError } from '../../application/setup-check.service'

const BASE_CHAIN_ID = 8453
const PAGE_SIZE = 1_000
const MAX_OFFER_PAGES = 100
const MAX_OFFER_ITEMS = PAGE_SIZE * MAX_OFFER_PAGES
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// morpho-org/deployments@24c04410 address-book.json, Base EcrecoverRatifier
// 0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E. eth_getCode at Base block 49198997
// through Morpho eRPC; this deployment-specific hash includes immutable MIDNIGHT
// 0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A.
const BASE_ECRECOVER_RATIFIER_RUNTIME_HASH =
  '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
const MIDNIGHT_SETUP_ABI = parseAbi([
  'function isAuthorized(address authorizer, address authorized) view returns (bool)',
  'function tickSpacing(bytes32 id) view returns (uint8)',
  'function toMarket(bytes32 id) view returns ((uint256 chainId,address midnight,address loanToken,(address token,uint256 lltv,uint256 liquidationCursor,address oracle)[] collateralParams,uint256 maturity,uint256 rcfThreshold,address enterGate,address liquidatorGate))'
])
const ECRECOVER_RATIFIER_ABI = parseAbi([
  'function MIDNIGHT() view returns (address)',
  'function isRootCanceled(address maker, bytes32 root) view returns (bool)'
])
const MORPHO_BLUE_SETUP_ABI = parseAbi([
  'function idToMarketParams(bytes32 id) view returns ((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))',
  'function market(bytes32 id) view returns ((uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))'
])
const EMPTY_ROOT = `0x${'00'.repeat(32)}`

/** Minimal read-only viem surface required by the setup-state adapter. */
export interface ChainReader {
  /** @returns Connected EVM chain ID. */
  getChainId(): Promise<number>
  /** @param parameters - Contract address. @returns Runtime bytecode when deployed. */
  getCode(parameters: { address: Address }): Promise<Hex | undefined>
  /** @param parameters - Account address. @returns Native-token balance in wei. */
  getBalance(parameters: { address: Address }): Promise<bigint>
  /**
   * @param parameters - Latest-block tag or exact historical block number.
   * @returns Block number and timestamp without mutating chain state.
   */
  getBlock(parameters: { blockTag?: 'latest'; blockNumber?: bigint }): Promise<{
    number: bigint | null
    timestamp: bigint
  }>
  /** @param parameters - Viem read-contract request. @returns ABI-decoded contract result. */
  readContract(parameters: Record<string, unknown>): Promise<unknown>
}

type ProviderId = 'morpho-api' | 'router-api'
type JsonRequest = (url: string, provider: ProviderId, timeoutMs?: number) => Promise<unknown>

type SetupStateOptions = {
  privateKey: Hex
  midnight: Address
  loanAsset: Address
  morphoApiBaseUrl: string
  routerApiBaseUrl: string
  marketIds: readonly Hex[]
  v0OfferGroupIds: readonly Hex[]
  referenceMarketId: Hex
  referenceLookbackBlocks?: bigint
  requestTimeoutMs?: number
  now?: () => number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function address(value: unknown, label: string) {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${label} must be an address`)
  return getAddress(value)
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${label} must be a 32-byte hex value`)
  }
  return value
}

function integer(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`)
  }
  return value
}

function bigint(value: unknown, label: string) {
  if (typeof value !== 'bigint') throw new Error(`${label} must be a bigint`)
  return value
}

function marketFromContract(value: unknown) {
  const market = object(value, 'Midnight.toMarket response')
  return {
    chainId: bigint(market.chainId, 'market.chainId'),
    midnight: address(market.midnight, 'market.midnight'),
    loanToken: address(market.loanToken, 'market.loanToken'),
    maturity: bigint(market.maturity, 'market.maturity')
  }
}

function marketFromApi(value: unknown) {
  const market = object(value, 'Morpho API market')
  return {
    id: bytes32(market.market_id, 'market_id'),
    listed: market.listed === true,
    loanToken: address(market.loan_token, 'loan_token'),
    maturity: BigInt(integer(market.maturity, 'maturity'))
  }
}

function offerFromApi(value: unknown) {
  const item = object(value, 'Router offer item')
  const offer = object(item.offer, 'Router offer')
  return {
    marketId: bytes32(item.market_id, 'offer market_id'),
    maker: address(offer.maker, 'offer maker'),
    group: bytes32(offer.group, 'offer group'),
    buy: offer.buy === true,
    tick: integer(offer.tick, 'offer tick')
  }
}

function routerEcrecoverRatifiers(value: unknown) {
  const data = array(
    object(value, 'Router config contracts response').data,
    'Router config contracts'
  )
  return data.flatMap(item => {
    const contract = object(item, 'Router config contract')
    if (integer(contract.chain_id, 'config contract chain_id') !== BASE_CHAIN_ID) return []
    if (contract.name !== 'ecrecoverRatifier') return []
    return [address(contract.address, 'config contract address')]
  })
}

function invertedMarketIds(
  offers: readonly ReturnType<typeof offerFromApi>[],
  configuredMarkets: readonly Hex[]
) {
  return configuredMarkets.filter(marketId => {
    const marketOffers = offers.filter(offer => offer.marketId === marketId)
    const buys = marketOffers.filter(offer => offer.buy).map(offer => offer.tick)
    const sells = marketOffers.filter(offer => !offer.buy).map(offer => offer.tick)
    return buys.length > 0 && sells.length > 0 && Math.max(...buys) >= Math.min(...sells)
  })
}

function routerTimeout() {
  return new SafeProviderError({
    kind: 'provider-error',
    provider: 'router-api',
    name: 'TimeoutError',
    code: 'REQUEST_TIMEOUT',
    context: 'request'
  })
}

/**
 * Fetches and decodes JSON under a per-request timeout while redacting unsafe failure details.
 * @param url - Provider endpoint; it is used for the request but never copied into thrown metadata.
 * @param provider - Fixed provider identifier safe for reports.
 * @param timeoutMs - Abort timeout in milliseconds, defaulting to 10 seconds.
 * @returns Parsed JSON response value.
 * @throws `SafeProviderError` with allowlisted provider/status/context metadata on HTTP,
 * timeout, network, or JSON failures; raw URLs and response bodies are not exposed.
 * @remarks Performs one read-only HTTP GET and has no chain or filesystem side effects.
 */
export async function requestJson(url: string, provider: ProviderId, timeoutMs = 10_000) {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
    if (!response.ok) {
      throw new SafeProviderError({
        kind: 'provider-error',
        provider,
        name: 'HttpError',
        status: response.status,
        context: 'request'
      })
    }
    return await response.json()
  } catch (error) {
    if (error instanceof SafeProviderError) throw error
    throw new SafeProviderError({
      kind: 'provider-error',
      provider,
      name: signal.aborted ? 'TimeoutError' : 'NetworkError',
      ...(signal.aborted ? { code: 'REQUEST_TIMEOUT' } : {}),
      context: 'request'
    })
  }
}

/** Read-only viem/API adapter that gathers setup facts and validates provider agreement. */
export class ViemSetupStateService implements SetupStateService {
  private readonly derivedMaker: Address

  /**
   * Creates a state adapter and derives the maker address locally from the configured private key.
   * @param chain - Current-state Base reader.
   * @param reference - Archive-capable Base reader.
   * @param request - JSON transport receiving only fixed provider IDs and explicit timeouts.
   * @param options - Validated addresses, IDs, endpoints, deadline, and test clock.
   * @remarks Construction does not contact providers, sign data, log secrets, or execute writes.
   */
  constructor(
    private readonly chain: ChainReader,
    private readonly reference: Pick<ChainReader, 'getBlock' | 'readContract'>,
    private readonly request: JsonRequest,
    private readonly options: SetupStateOptions
  ) {
    this.derivedMaker = privateKeyToAccount(options.privateKey).address
  }

  /** @returns The connected chain ID from the current-state RPC. */
  getChainId() {
    return this.chain.getChainId()
  }

  /** @param target - Address to inspect. @returns Runtime bytecode when deployed. */
  getCode(target: Address) {
    return this.chain.getCode({ address: target })
  }

  /** @returns The locally derived maker; no signing or provider request occurs. */
  async getDerivedMaker() {
    return this.derivedMaker
  }

  /** @param owner - Account to inspect. @returns Its current native-token balance. */
  getNativeBalance(owner: Address) {
    return this.chain.getBalance({ address: owner })
  }

  /**
   * Reads the maker's ERC-20 allowance for the configured Midnight singleton.
   * @param owner - Token owner.
   * @param loanAsset - ERC-20 contract.
   * @returns Configured Midnight spender and decoded allowance.
   * @throws When the provider response is not a bigint.
   */
  async getLoanAllowance(owner: Address, loanAsset: Address) {
    const amount = await this.chain.readContract({
      address: loanAsset,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, this.options.midnight]
    })
    if (typeof amount !== 'bigint') throw new Error('ERC20 allowance response must be bigint')
    return { spender: this.options.midnight, amount }
  }

  /**
   * Cross-checks a ratifier against Router registry, exact runtime hash, immutable target, callable
   * Ecrecover surface, and Midnight authorization.
   * @param maker - Maker whose authorization/root surface is read.
   * @param ratifier - Candidate ratifier address.
   * @returns Five readiness facts without exposing provider URLs or bytecode.
   * @throws On malformed provider/contract responses or failed reads.
   * @remarks All five independent reads start concurrently through `Promise.all`; this is read-only.
   */
  async getRatifier(maker: Address, ratifier: Address) {
    const [routerContracts, code, ratifierMidnight, rootCanceled, authorized] = await Promise.all([
      this.request(
        `${this.options.routerApiBaseUrl}/v0/config/contracts?chains=${BASE_CHAIN_ID}&limit=100`,
        'router-api'
      ),
      this.chain.getCode({ address: ratifier }),
      this.chain.readContract({
        address: ratifier,
        abi: ECRECOVER_RATIFIER_ABI,
        functionName: 'MIDNIGHT'
      }),
      this.chain.readContract({
        address: ratifier,
        abi: ECRECOVER_RATIFIER_ABI,
        functionName: 'isRootCanceled',
        args: [maker, EMPTY_ROOT]
      }),
      this.chain.readContract({
        address: this.options.midnight,
        abi: MIDNIGHT_SETUP_ABI,
        functionName: 'isAuthorized',
        args: [maker, ratifier]
      })
    ])
    if (typeof authorized !== 'boolean') {
      throw new Error('Midnight isAuthorized response must be boolean')
    }
    if (typeof ratifierMidnight !== 'string' || !isAddress(ratifierMidnight)) {
      throw new Error('EcrecoverRatifier MIDNIGHT response must be an address')
    }
    if (typeof rootCanceled !== 'boolean') {
      throw new Error('EcrecoverRatifier isRootCanceled response must be boolean')
    }
    return {
      listed: routerEcrecoverRatifiers(routerContracts).some(listed =>
        isAddressEqual(ratifier, listed)
      ),
      deployed: code !== undefined && code !== '0x',
      midnightMatches: isAddressEqual(ratifierMidnight, this.options.midnight),
      ecrecoverSurface:
        code !== undefined &&
        code !== '0x' &&
        keccak256(code) === BASE_ECRECOVER_RATIFIER_RUNTIME_HASH,
      authorized
    }
  }

  /**
   * Cross-checks one Midnight market between the Morpho API and on-chain state.
   * @param id - Configured market ID.
   * @returns Validated listing, activity, loan asset, tick spacing, and maturity.
   * @throws On missing/extra API rows, malformed values, identity disagreement, or invalid chain data.
   * @remarks API, market, and tick-spacing reads run concurrently through `Promise.all`; no writes.
   */
  async getBook(id: Hex): Promise<BookSetup> {
    const query = new URLSearchParams({
      chain_ids: String(BASE_CHAIN_ID),
      market_ids: id,
      listed: 'true',
      active_only: 'true',
      limit: '1'
    })
    const [apiResponse, contractResponse, tickSpacing] = await Promise.all([
      this.request(
        `${this.options.morphoApiBaseUrl}/v0/midnight/markets?${query.toString()}`,
        'morpho-api'
      ),
      this.chain.readContract({
        address: this.options.midnight,
        abi: MIDNIGHT_SETUP_ABI,
        functionName: 'toMarket',
        args: [id]
      }),
      this.chain.readContract({
        address: this.options.midnight,
        abi: MIDNIGHT_SETUP_ABI,
        functionName: 'tickSpacing',
        args: [id]
      })
    ])
    const data = array(object(apiResponse, 'Morpho API response').data, 'Morpho API data')
    if (data.length !== 1) throw new Error(`Morpho API returned ${data.length} markets for ${id}`)
    const apiMarket = marketFromApi(data[0])
    const contractMarket = marketFromContract(contractResponse)
    if (apiMarket.id !== id) throw new Error(`Morpho API returned ${apiMarket.id} for ${id}`)
    if (contractMarket.chainId !== BigInt(BASE_CHAIN_ID))
      throw new Error('market chain id is not Base')
    if (!isAddressEqual(contractMarket.midnight, this.options.midnight)) {
      throw new Error('market points at an unexpected Midnight contract')
    }
    if (!isAddressEqual(apiMarket.loanToken, contractMarket.loanToken)) {
      throw new Error('API and chain disagree on the market loan asset')
    }
    if (apiMarket.maturity !== contractMarket.maturity) {
      throw new Error('API and chain disagree on market maturity')
    }
    if (typeof tickSpacing !== 'number') throw new Error('tickSpacing response must be a number')
    return {
      id,
      allowlisted: apiMarket.listed,
      active: true,
      loanAsset: contractMarket.loanToken,
      tickSpacing,
      maturity: contractMarket.maturity
    }
  }

  /** @returns Latest current-state block timestamp from a read-only RPC call. */
  async getLatestTimestamp() {
    return (await this.chain.getBlock({ blockTag: 'latest' })).timestamp
  }

  /**
   * Proves the exact reference market is readable at a historical archive block.
   * @returns Reference-market identity plus current and archive readability flags.
   * @throws When history is insufficient or market parameters/state are absent, zero, or malformed.
   * @remarks After locating the historical block, independent parameter and state reads run through
   * `Promise.all`; the method is read-only.
   */
  async checkReference() {
    const latest = await this.reference.getBlock({ blockTag: 'latest' })
    if (latest.number === null) throw new Error('reference RPC latest block has no number')
    const lookback = this.options.referenceLookbackBlocks ?? 10_800n
    if (latest.number < lookback) throw new Error('reference RPC has insufficient history')
    const historicalBlock = latest.number - lookback
    await this.reference.getBlock({ blockNumber: historicalBlock })
    const [paramsResponse, marketResponse] = await Promise.all([
      this.reference.readContract({
        address: getChainAddress(BASE_CHAIN_ID, 'morpho'),
        abi: MORPHO_BLUE_SETUP_ABI,
        functionName: 'idToMarketParams',
        args: [this.options.referenceMarketId],
        blockNumber: historicalBlock
      }),
      this.reference.readContract({
        address: getChainAddress(BASE_CHAIN_ID, 'morpho'),
        abi: MORPHO_BLUE_SETUP_ABI,
        functionName: 'market',
        args: [this.options.referenceMarketId],
        blockNumber: historicalBlock
      })
    ])
    const params = object(paramsResponse, 'Morpho Blue reference market params')
    const market = object(marketResponse, 'Morpho Blue reference market state')
    if (address(params.loanToken, 'reference market loanToken') === zeroAddress) {
      throw new Error('configured reference market does not exist')
    }
    if (bigint(market.totalSupplyShares, 'reference market totalSupplyShares') === 0n) {
      throw new Error('configured reference market has zero supply shares')
    }
    if (bigint(market.lastUpdate, 'reference market lastUpdate') === 0n) {
      throw new Error('configured reference market state is uninitialized')
    }
    return {
      marketId: this.options.referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }
  }

  /**
   * Traverses all takeable offers for a maker and detects unknown groups or inverted books.
   * @param maker - Maker whose active offers are inspected.
   * @returns Deduplicated unknown namespaces and configured markets with crossed buy/sell ticks.
   * @throws On malformed responses, repeated cursors, more than 100 pages or 100,000 items, or when
   * the single absolute request deadline expires.
   * @remarks Pagination is necessarily sequential because each cursor depends on the previous page;
   * the deadline covers the whole traversal. This method never creates, cancels, or takes an offer.
   */
  async inspectOffers(maker: Address) {
    const offers: ReturnType<typeof offerFromApi>[] = []
    const seenCursors = new Set<string>()
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const now = this.options.now ?? performance.now.bind(performance)
    const deadline = now() + requestTimeoutMs
    let pageCount = 0
    let cursor: string | undefined
    do {
      if (pageCount >= MAX_OFFER_PAGES) throw new Error('Router offer page limit exceeded')
      const remainingMs = Math.floor(deadline - now())
      if (remainingMs <= 0) throw routerTimeout()
      pageCount += 1
      const query = new URLSearchParams({ maker, limit: String(PAGE_SIZE) })
      if (cursor) query.set('cursor', cursor)
      const response = object(
        await this.request(
          `${this.options.routerApiBaseUrl}/v0/midnight/takeable-offers?${query.toString()}`,
          'router-api',
          Math.min(requestTimeoutMs, remainingMs)
        ),
        'Router response'
      )
      const data = array(response.data, 'Router data')
      if (offers.length + data.length > MAX_OFFER_ITEMS) {
        throw new Error('Router offer item limit exceeded')
      }
      offers.push(...data.map(offerFromApi))
      if (
        response.cursor !== null &&
        response.cursor !== undefined &&
        typeof response.cursor !== 'string'
      ) {
        throw new Error('Router cursor must be a string or null')
      }
      cursor = response.cursor ?? undefined
      if (cursor && seenCursors.has(cursor)) throw new Error('Router cursor repeated')
      if (cursor) seenCursors.add(cursor)
    } while (cursor)

    const makerOffers = offers.filter(offer => isAddressEqual(offer.maker, maker))
    const knownGroups = new Set(this.options.v0OfferGroupIds)
    const unknownNamespaces = [
      ...new Set(makerOffers.map(offer => offer.group).filter(group => !knownGroups.has(group)))
    ]
    return {
      unknownNamespaces,
      invertedMarketIds: invertedMarketIds(makerOffers, this.options.marketIds)
    }
  }

  /**
   * Reports the intentionally excluded V0 position-health surface.
   * @returns A stable not-required result because V0 creates no collateralized debt.
   * @remarks Pure and read-only; no provider request is made.
   */
  async checkPositionHealth() {
    return { status: 'not-required' as const, reason: 'V0 does not create collateralized debt' }
  }
}
