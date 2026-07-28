import type { Address, Hex } from 'viem'

import { ecrecoverRatifierAbi, midnightAbi } from '@morpho-org/midnight-sdk'
import { MidnightApi } from '@morpho-org/midnight-sdk/api'
import { blueAbi } from '@morpho-org/morpho-sdk/abis'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { erc20Abi, isAddress, isAddressEqual, keccak256, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { BookSetup, SetupStateService } from '../../application/setup-check.service'
import type { JsonRequest } from './http-json.utils'

import { listedBooksJsonRequestFetch } from './http-json.utils'
import { ProviderPaginationError } from './provider-pagination.error'
import { executeProviderRead } from './provider-read.utils'
import { ProviderResponseError } from './provider-response.error'
import {
  addressValue,
  BASE_CHAIN_ID,
  BASE_ECRECOVER_RATIFIER_RUNTIME_HASH,
  DEFAULT_REQUEST_TIMEOUT_MS,
  invertedMarketIds,
  marketFromApi,
  marketFromContract,
  MAX_OFFER_ITEMS,
  MAX_OFFER_PAGES,
  objectRecord,
  offerFromApi,
  offersFromGroups,
  PAGE_SIZE,
  providerBigInt,
  routerEcrecoverRatifiers,
  morphoApiTimeout
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
   * @throws `ProviderReadError` on a sanitized RPC rejection.
   * @remarks Read-only; performs no writes.
   */
  getChainId() {
    return executeProviderRead('rpc', 'chain-id', () => this.chain.getChainId())
  }

  /**
   * Reads target runtime bytecode through the current-state provider.
   * @param target - Address to inspect.
   * @returns Runtime bytecode when deployed.
   * @throws `ProviderReadError` on a sanitized RPC rejection.
   * @remarks Read-only; performs no writes.
   */
  getCode(target: Address) {
    return executeProviderRead('rpc', 'contract-code', () =>
      this.chain.getCode({ address: target })
    )
  }

  /** Derives no new state and returns the cached local maker. @returns The locally derived maker; no signing or provider request occurs. */
  async getDerivedMaker() {
    return this.derivedMaker
  }

  /**
   * Reads an account native-token balance through the current-state provider.
   * @param owner - Account to inspect.
   * @returns Its current native-token balance.
   * @throws `ProviderReadError` on a sanitized RPC rejection.
   * @remarks Read-only; performs no writes.
   */
  getNativeBalance(owner: Address) {
    return executeProviderRead('rpc', 'native-balance', () =>
      this.chain.getBalance({ address: owner })
    )
  }

  /**
   * Reads the maker's ERC-20 allowance for the configured Midnight singleton.
   * @param owner - Token owner.
   * @param loanAsset - ERC-20 contract.
   * @returns Configured Midnight spender and decoded allowance.
   * @throws `ProviderReadError` on a sanitized RPC rejection, or `ProviderResponseError` when the
   * decoded allowance is not a bigint.
   * @remarks Read-only; performs no writes.
   */
  async getLoanAllowance(owner: Address, loanAsset: Address) {
    const amount = await executeProviderRead('rpc', 'loan-allowance', () =>
      this.chain.readContract({
        address: loanAsset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, this.options.midnight]
      })
    )
    if (typeof amount !== 'bigint') {
      throw new ProviderResponseError(
        'rpc',
        'erc20-allowance',
        'ERC20 allowance response must be bigint'
      )
    }
    return { spender: this.options.midnight, amount }
  }

  /**
   * Cross-checks a ratifier against Router registry, exact runtime hash, immutable target, callable
   * Ecrecover surface, and Midnight authorization.
   * @param maker - Maker whose authorization/root surface is read.
   * @param ratifier - Candidate ratifier address.
   * @returns Five readiness facts without exposing provider URLs or bytecode.
   * @throws `ProviderReadError` on a sanitized Router/RPC rejection, or `ProviderResponseError` for
   * malformed provider or contract responses.
   * @remarks Registry, bytecode, and authorization reads start concurrently. Ratifier ABI reads then
   * run concurrently only after the exact Ecrecover runtime is proven; this is read-only.
   */
  async getRatifier(maker: Address, ratifier: Address) {
    const [routerContracts, code, authorized] = await Promise.all([
      executeProviderRead('router-api', 'ratifier-registry', () =>
        this.request(
          `${this.options.routerApiBaseUrl}/v0/config/contracts?chains=${BASE_CHAIN_ID}&limit=100`,
          'router-api'
        )
      ),
      executeProviderRead('rpc', 'ratifier-code', () => this.chain.getCode({ address: ratifier })),
      executeProviderRead('rpc', 'ratifier-authorization', () =>
        this.chain.readContract({
          address: this.options.midnight,
          abi: midnightAbi,
          functionName: 'isAuthorized',
          args: [maker, ratifier]
        })
      )
    ])
    if (typeof authorized !== 'boolean') {
      throw new ProviderResponseError(
        'rpc',
        'ratifier-authorization',
        'Midnight isAuthorized response must be boolean'
      )
    }
    const listed = routerEcrecoverRatifiers(routerContracts).some(listedRatifier =>
      isAddressEqual(ratifier, listedRatifier)
    )
    const deployed = code !== undefined && code !== '0x'
    const ecrecoverSurface =
      deployed && code !== undefined && keccak256(code) === BASE_ECRECOVER_RATIFIER_RUNTIME_HASH
    if (!ecrecoverSurface) {
      return {
        listed,
        deployed,
        midnightMatches: false,
        ecrecoverSurface: false,
        authorized
      }
    }
    const [ratifierMidnight, rootCanceled] = await Promise.all([
      executeProviderRead('rpc', 'ratifier-midnight', () =>
        this.chain.readContract({
          address: ratifier,
          abi: ecrecoverRatifierAbi,
          functionName: 'MIDNIGHT'
        })
      ),
      executeProviderRead('rpc', 'ratifier-root', () =>
        this.chain.readContract({
          address: ratifier,
          abi: ecrecoverRatifierAbi,
          functionName: 'isRootCanceled',
          args: [maker, zeroHash]
        })
      )
    ])
    if (typeof ratifierMidnight !== 'string' || !isAddress(ratifierMidnight)) {
      throw new ProviderResponseError(
        'rpc',
        'ratifier-midnight',
        'EcrecoverRatifier MIDNIGHT response must be an address'
      )
    }
    if (typeof rootCanceled !== 'boolean') {
      throw new ProviderResponseError(
        'rpc',
        'ratifier-root',
        'EcrecoverRatifier isRootCanceled response must be boolean'
      )
    }
    return {
      listed,
      deployed,
      midnightMatches: isAddressEqual(ratifierMidnight, this.options.midnight),
      ecrecoverSurface,
      authorized
    }
  }

  /**
   * Cross-checks one Midnight market between the Morpho API and on-chain state.
   * @param id - Configured market ID.
   * @returns Validated listing, activity, loan asset, tick spacing, and maturity.
   * @throws `ProviderReadError` on a sanitized API/RPC rejection, or `ProviderResponseError` for
   * missing/extra rows, malformed values, identity disagreement, or invalid chain data.
   * @remarks API, market, and tick-spacing reads run concurrently through `Promise.all`; no writes.
   */
  async getBook(id: Hex): Promise<BookSetup> {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const [apiResponse, contractResponse, tickSpacing] = await Promise.all([
      executeProviderRead('morpho-api', 'book-api', () =>
        MidnightApi.fetchBooks({
          baseUrl: `${this.options.morphoApiBaseUrl}/v0/midnight`,
          chainIds: [BASE_CHAIN_ID],
          marketIds: [id],
          limit: 1,
          fetch: listedBooksJsonRequestFetch(this.request, requestTimeoutMs)
        })
      ),
      executeProviderRead('rpc', 'book-market', () =>
        this.chain.readContract({
          address: this.options.midnight,
          abi: midnightAbi,
          functionName: 'toMarket',
          args: [id]
        })
      ),
      executeProviderRead('rpc', 'book-tick-spacing', () =>
        this.chain.readContract({
          address: this.options.midnight,
          abi: midnightAbi,
          functionName: 'tickSpacing',
          args: [id]
        })
      )
    ])
    if (apiResponse.data.length !== 1) {
      throw new ProviderResponseError(
        'morpho-api',
        'book-count',
        `Morpho API returned ${apiResponse.data.length} books for ${id}`
      )
    }
    const apiMarket = marketFromApi(apiResponse.data[0])
    const contractMarket = marketFromContract(contractResponse)
    if (apiMarket.id !== id) {
      throw new ProviderResponseError(
        'morpho-api',
        'book-identity',
        `Morpho API returned ${apiMarket.id} for ${id}`
      )
    }
    if (apiMarket.chainId !== BASE_CHAIN_ID) {
      throw new ProviderResponseError('morpho-api', 'book-chain', 'API market chain id is not Base')
    }
    if (!isAddressEqual(apiMarket.midnight, this.options.midnight)) {
      throw new ProviderResponseError(
        'morpho-api',
        'book-midnight',
        'API market points at an unexpected Midnight contract'
      )
    }
    if (contractMarket.chainId !== BigInt(BASE_CHAIN_ID)) {
      throw new ProviderResponseError('rpc', 'book-chain', 'market chain id is not Base')
    }
    if (!isAddressEqual(contractMarket.midnight, this.options.midnight)) {
      throw new ProviderResponseError(
        'rpc',
        'book-midnight',
        'market points at an unexpected Midnight contract'
      )
    }
    if (!isAddressEqual(apiMarket.loanToken, contractMarket.loanToken)) {
      throw new ProviderResponseError(
        'provider',
        'book-loan-asset',
        'API and chain disagree on the market loan asset'
      )
    }
    if (apiMarket.maturity !== contractMarket.maturity) {
      throw new ProviderResponseError(
        'provider',
        'book-maturity',
        'API and chain disagree on market maturity'
      )
    }
    if (typeof tickSpacing !== 'number') {
      throw new ProviderResponseError(
        'rpc',
        'book-tick-spacing',
        'tickSpacing response must be a number'
      )
    }
    return {
      id,
      allowlisted: true,
      active: true,
      loanAsset: contractMarket.loanToken,
      tickSpacing,
      maturity: contractMarket.maturity
    }
  }

  /**
   * Reads the latest timestamp through the current-state provider.
   * @returns Latest current-state block timestamp from a read-only RPC call.
   * @throws `ProviderReadError` on a sanitized RPC rejection.
   * @remarks Read-only; performs no writes.
   */
  async getLatestTimestamp() {
    return (
      await executeProviderRead('rpc', 'latest-timestamp', () =>
        this.chain.getBlock({ blockTag: 'latest' })
      )
    ).timestamp
  }

  /**
   * Proves the exact reference market is readable at a historical archive block.
   * @returns Reference-market identity plus current and archive readability flags.
   * @throws `ProviderReadError` on a sanitized archive-RPC rejection, or `ProviderResponseError` for
   * insufficient history and absent, zero, or malformed market state.
   * @remarks After locating the historical block, independent parameter and state reads run through
   * `Promise.all`; the method is read-only.
   */
  async checkReference() {
    const latest = await executeProviderRead('archive-rpc', 'reference-latest-block', () =>
      this.reference.getBlock({ blockTag: 'latest' })
    )
    if (latest.number === null) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-block',
        'reference RPC latest block has no number'
      )
    }
    const lookback = this.options.referenceLookbackBlocks ?? 10_800n
    if (latest.number < lookback) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-history',
        'reference RPC has insufficient history'
      )
    }
    const historicalBlock = latest.number - lookback
    await executeProviderRead('archive-rpc', 'reference-historical-block', () =>
      this.reference.getBlock({ blockNumber: historicalBlock })
    )
    const [paramsResponse, marketResponse] = await Promise.all([
      executeProviderRead('archive-rpc', 'reference-market-params', () =>
        this.reference.readContract({
          address: getChainAddress(BASE_CHAIN_ID, 'morpho'),
          abi: blueAbi,
          functionName: 'idToMarketParams',
          args: [this.options.referenceMarketId],
          blockNumber: historicalBlock
        })
      ),
      executeProviderRead('archive-rpc', 'reference-market-state', () =>
        this.reference.readContract({
          address: getChainAddress(BASE_CHAIN_ID, 'morpho'),
          abi: blueAbi,
          functionName: 'market',
          args: [this.options.referenceMarketId],
          blockNumber: historicalBlock
        })
      )
    ])
    const params = objectRecord(paramsResponse, 'Morpho Blue reference market params')
    const market = objectRecord(marketResponse, 'Morpho Blue reference market state')
    const referenceLoanAsset = addressValue(params.loanToken, 'reference market loanToken')
    if (referenceLoanAsset === zeroAddress) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market does not exist'
      )
    }
    if (!isAddressEqual(referenceLoanAsset, this.options.loanAsset)) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-loan-asset',
        'configured reference market uses an unexpected loan asset'
      )
    }
    if (providerBigInt(market.totalSupplyShares, 'reference market totalSupplyShares') === 0n) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market has zero supply shares'
      )
    }
    if (providerBigInt(market.lastUpdate, 'reference market lastUpdate') === 0n) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market state is uninitialized'
      )
    }
    return {
      marketId: this.options.referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }
  }

  /**
   * Traverses every active offer group for a maker and detects unknown groups, unconfigured markets,
   * or crossed books, including fresh offers whose takeable amount has not been measured yet.
   * @param maker - Maker whose complete active offer-group set is inspected.
   * @returns Deduplicated unknown namespaces, unconfigured markets, and all crossed market IDs.
   * @throws `ProviderReadError` on a sanitized Morpho API rejection; `ProviderResponseError` or
   * `ProviderPaginationError` on malformed or unbounded data; or a safe timeout error when the
   * single absolute request deadline expires.
   * @remarks Uses the authoritative cursor-paginated `/users/{maker}/offer-groups` source. Pagination
   * is necessarily sequential because each cursor depends on the previous page; one aggregate
   * absolute deadline covers the whole read-only traversal. midnight-sdk 1.2.0 has no offer-group
   * endpoint/entity, so only this bounded transport and strict response projection remain local.
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
      if (pageCount >= MAX_OFFER_PAGES) {
        throw new ProviderPaginationError(
          'morpho-api',
          'page-limit',
          'Morpho API offer page limit exceeded'
        )
      }
      const remainingMs = Math.floor(deadline - now())
      if (remainingMs <= 0) throw morphoApiTimeout()
      pageCount += 1
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (cursor) query.set('cursor', cursor)
      const response = objectRecord(
        await executeProviderRead('morpho-api', 'offer-groups', () =>
          this.request(
            `${this.options.morphoApiBaseUrl}/v0/midnight/users/${encodeURIComponent(maker)}/offer-groups?${query.toString()}`,
            'morpho-api',
            Math.min(requestTimeoutMs, remainingMs)
          )
        ),
        'Morpho API response'
      )
      const groupData = response.data
      const groups = Array.isArray(groupData) ? groupData : []
      if (!Array.isArray(groupData)) {
        throw new ProviderResponseError(
          'morpho-api',
          'offer-groups',
          'Morpho API data must be an array'
        )
      }
      if (groups.length > PAGE_SIZE) {
        throw new ProviderPaginationError(
          'morpho-api',
          'page-size',
          'Morpho API offer-group page size exceeded'
        )
      }
      const pageOffers = offersFromGroups(groups)
      if (offers.length + pageOffers.length > MAX_OFFER_ITEMS) {
        throw new ProviderPaginationError(
          'morpho-api',
          'item-limit',
          'Morpho API offer item limit exceeded'
        )
      }
      offers.push(...pageOffers)
      if (
        response.cursor !== null &&
        response.cursor !== undefined &&
        typeof response.cursor !== 'string'
      ) {
        throw new ProviderResponseError(
          'morpho-api',
          'cursor',
          'Morpho API cursor must be a string or null'
        )
      }
      cursor = response.cursor ?? undefined
      if (cursor && seenCursors.has(cursor)) {
        throw new ProviderPaginationError(
          'morpho-api',
          'repeated-cursor',
          'Morpho API cursor repeated'
        )
      }
      if (cursor) seenCursors.add(cursor)
    } while (cursor)

    if (offers.some(offer => !isAddressEqual(offer.maker, maker))) {
      throw new ProviderResponseError(
        'morpho-api',
        'offer-maker',
        'Morpho API active offer maker does not match requested maker'
      )
    }
    const knownGroups = new Set(this.options.v0OfferGroupIds)
    const configuredMarkets = new Set(this.options.marketIds)
    return {
      unknownNamespaces: [
        ...new Set(offers.map(offer => offer.group).filter(group => !knownGroups.has(group)))
      ],
      unknownMarketIds: [
        ...new Set(
          offers.map(offer => offer.marketId).filter(marketId => !configuredMarkets.has(marketId))
        )
      ],
      invertedMarketIds: invertedMarketIds(offers)
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
