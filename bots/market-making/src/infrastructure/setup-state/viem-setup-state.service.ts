import type { Address, Hex } from 'viem'

import { ecrecoverRatifierAbi, midnightAbi } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { erc20Abi, isAddress, isAddressEqual, keccak256, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { BookSetup, SetupStateService } from '../../application/setup-check.service'
import type { JsonRequest } from './http-json.utils'

import {
  addressValue,
  arrayValue,
  BASE_CHAIN_ID,
  BASE_ECRECOVER_RATIFIER_RUNTIME_HASH,
  DEFAULT_REQUEST_TIMEOUT_MS,
  invertedMarketIds,
  marketFromApi,
  marketFromContract,
  MAX_OFFER_ITEMS,
  MAX_OFFER_PAGES,
  MORPHO_BLUE_SETUP_ABI,
  objectRecord,
  offerFromApi,
  PAGE_SIZE,
  providerBigInt,
  routerEcrecoverRatifiers,
  routerTimeout
} from './viem-setup-state.utils'

/** Minimal read-only viem surface required by the setup-state adapter. */
export interface ChainReader {
  /**
   * Reads the connected chain identity from the RPC provider.
   * @returns Connected EVM chain ID.
   * @throws When the RPC transport rejects or returns an invalid chain-id response.
   */
  getChainId(): Promise<number>
  /**
   * Reads runtime bytecode from the RPC provider.
   * @param parameters - Contract address.
   * @returns Runtime bytecode when deployed.
   * @throws When the RPC transport rejects or returns malformed bytecode.
   */
  getCode(parameters: { address: Address }): Promise<Hex | undefined>
  /**
   * Reads native-token balance from the RPC provider.
   * @param parameters - Account address.
   * @returns Native-token balance in wei.
   * @throws When the RPC transport rejects or returns a malformed balance.
   */
  getBalance(parameters: { address: Address }): Promise<bigint>
  /**
   * Reads a latest or historical block from the RPC provider.
   * @param parameters - Latest-block tag or exact historical block number.
   * @returns Block number and timestamp without mutating chain state.
   * @throws When the RPC transport rejects, history is unavailable, or the block is malformed.
   */
  getBlock(parameters: { blockTag?: 'latest'; blockNumber?: bigint }): Promise<{
    number: bigint | null
    timestamp: bigint
  }>
  /**
   * Executes one read-only ABI-decoded contract call through the RPC provider.
   * @param parameters - Viem read-contract request.
   * @returns ABI-decoded contract result.
   * @throws When the RPC rejects, the call reverts, or ABI decoding fails.
   */
  readContract(parameters: Record<string, unknown>): Promise<unknown>
}

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

  /**
   * Reads the connected chain identity through the current-state provider.
   * @returns The connected chain ID from the current-state RPC.
   * @throws When the current-state RPC rejects or returns an invalid chain ID.
   * @remarks Read-only; performs no writes.
   */
  getChainId() {
    return this.chain.getChainId()
  }

  /**
   * Reads target runtime bytecode through the current-state provider.
   * @param target - Address to inspect.
   * @returns Runtime bytecode when deployed.
   * @throws When the current-state RPC rejects or returns malformed bytecode.
   * @remarks Read-only; performs no writes.
   */
  getCode(target: Address) {
    return this.chain.getCode({ address: target })
  }

  /** Derives no new state and returns the cached local maker. @returns The locally derived maker; no signing or provider request occurs. */
  async getDerivedMaker() {
    return this.derivedMaker
  }

  /**
   * Reads an account native-token balance through the current-state provider.
   * @param owner - Account to inspect.
   * @returns Its current native-token balance.
   * @throws When the current-state RPC rejects or returns a malformed balance.
   * @remarks Read-only; performs no writes.
   */
  getNativeBalance(owner: Address) {
    return this.chain.getBalance({ address: owner })
  }

  /**
   * Reads the maker's ERC-20 allowance for the configured Midnight singleton.
   * @param owner - Token owner.
   * @param loanAsset - ERC-20 contract.
   * @returns Configured Midnight spender and decoded allowance.
   * @throws When the provider rejects, the call reverts, or the response is not a bigint.
   * @remarks Read-only; performs no writes.
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
   * @throws On provider rejection, malformed provider/contract responses, or failed reads.
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
        abi: ecrecoverRatifierAbi,
        functionName: 'MIDNIGHT'
      }),
      this.chain.readContract({
        address: ratifier,
        abi: ecrecoverRatifierAbi,
        functionName: 'isRootCanceled',
        args: [maker, zeroHash]
      }),
      this.chain.readContract({
        address: this.options.midnight,
        abi: midnightAbi,
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
   * @throws On provider rejection, missing/extra API rows, malformed values, identity disagreement,
   * or invalid chain data.
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
        abi: midnightAbi,
        functionName: 'toMarket',
        args: [id]
      }),
      this.chain.readContract({
        address: this.options.midnight,
        abi: midnightAbi,
        functionName: 'tickSpacing',
        args: [id]
      })
    ])
    const data = arrayValue(
      objectRecord(apiResponse, 'Morpho API response').data,
      'Morpho API data'
    )
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

  /**
   * Reads the latest timestamp through the current-state provider.
   * @returns Latest current-state block timestamp from a read-only RPC call.
   * @throws When the current-state RPC rejects or returns a malformed block.
   * @remarks Read-only; performs no writes.
   */
  async getLatestTimestamp() {
    return (await this.chain.getBlock({ blockTag: 'latest' })).timestamp
  }

  /**
   * Proves the exact reference market is readable at a historical archive block.
   * @returns Reference-market identity plus current and archive readability flags.
   * @throws On provider rejection, insufficient history, or absent, zero, or malformed market state.
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
    const params = objectRecord(paramsResponse, 'Morpho Blue reference market params')
    const market = objectRecord(marketResponse, 'Morpho Blue reference market state')
    if (addressValue(params.loanToken, 'reference market loanToken') === zeroAddress) {
      throw new Error('configured reference market does not exist')
    }
    if (providerBigInt(market.totalSupplyShares, 'reference market totalSupplyShares') === 0n) {
      throw new Error('configured reference market has zero supply shares')
    }
    if (providerBigInt(market.lastUpdate, 'reference market lastUpdate') === 0n) {
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
   * the deadline covers the whole traversal. This read-only method never creates, cancels, or takes
   * an offer.
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
      const response = objectRecord(
        await this.request(
          `${this.options.routerApiBaseUrl}/v0/midnight/takeable-offers?${query.toString()}`,
          'router-api',
          Math.min(requestTimeoutMs, remainingMs)
        ),
        'Router response'
      )
      const data = arrayValue(response.data, 'Router data')
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
