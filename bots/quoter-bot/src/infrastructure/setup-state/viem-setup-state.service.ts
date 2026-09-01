import type { Address, Hex } from 'viem'

import { ecrecoverRatifierAbi, midnightAbi, setterRatifierAbi } from '@morpho-org/midnight-sdk'
import { blueAbi } from '@morpho-org/morpho-sdk/abis'
import { restructure } from '@morpho-org/morpho-sdk/utils'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { erc20Abi, isAddress, isAddressEqual, keccak256, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { BookSetup, SetupStateService } from '../../application/setup/setup-check.service'
import type { SupportedChainId } from '../../config/supported-chains.utils'
import type { JsonRequest } from './http-json.utils'

import { ratifierRuntimeHash, referenceLookbackBlocks } from '../../config/supported-chains.utils'
import { ProviderPaginationError } from './provider-pagination.error'
import { executeProviderRead } from './provider-read.utils'
import { ProviderResponseError } from './provider-response.error'
import {
  addressValue,
  apiMarkets,
  DEFAULT_REQUEST_TIMEOUT_MS,
  invertedMarketIds,
  marketFromContract,
  MAX_OFFER_ITEMS,
  MAX_OFFER_PAGES,
  objectValue,
  offerFromApi,
  offersFromGroups,
  PAGE_SIZE,
  bigintValue,
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
  chainId: SupportedChainId
  midnight: Address
  loanAsset: Address
  morphoApiBaseUrl: string
  marketIds: readonly Hex[]
  v0OfferGroupIds: readonly Hex[]
  readOwnedGroupIds: () => Promise<readonly Hex[]>
  ignoredOfferGroupIds?: readonly Hex[]
  readBootstrapGroupIds?: () => Promise<readonly Hex[]>
  readLadderSellGroupIds?: () => Promise<readonly Hex[]>
  referenceMarketId: Hex
  referenceLookbackBlocks?: bigint
  requestTimeoutMs?: number
  now?: () => number
} & (
  | { readOnly: true }
  | { readOnly?: false; privateKey: Hex }
  | { readOnly?: false; signerAddress: Address }
  | { readOnly?: false; deriveSignerAddress: () => Promise<Address> }
)

/** Read-only viem/API adapter that gathers setup facts and validates provider agreement. */
export class ViemSetupStateService implements SetupStateService {
  private readonly derivedMaker: Address | undefined

  /**
   * Creates a state adapter and derives the maker only when write authority is configured.
   * @param chain - Current-state Base reader.
   * @param reference - Archive-capable Base reader.
   * @param request - JSON transport receiving only fixed provider IDs and explicit timeouts.
   * @param options - Validated identity mode, addresses, IDs, endpoints, deadline, and test clock.
   * @remarks Construction does not contact providers, sign data, log secrets, or execute writes.
   * Read-only options carry no signer identity and never load a private key.
   */
  constructor(
    private readonly chain: ChainReader,
    private readonly reference: Pick<ChainReader, 'getChainId' | 'getBlock' | 'readContract'>,
    private readonly request: JsonRequest,
    private readonly options: SetupStateOptions
  ) {
    this.derivedMaker =
      options.readOnly || 'deriveSignerAddress' in options
        ? undefined
        : 'privateKey' in options
          ? privateKeyToAccount(options.privateKey).address
          : 'signerAddress' in options
            ? options.signerAddress
            : undefined
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
   * Reads the connected chain identity through the archive-capable reference provider.
   * @returns The chain ID the reference provider is actually serving.
   * @throws `ProviderReadError` on a sanitized archive-RPC rejection.
   * @remarks Read-only. The reference provider is configured separately from the current-state RPC,
   * so a stale endpoint for another chain is only detectable here.
   */
  getReferenceChainId() {
    return executeProviderRead('archive-rpc', 'reference-chain-id', () =>
      this.reference.getChainId()
    )
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

  /**
   * Resolves the configured signer address for the captured setup maker check.
   * @returns The locally derived or lazily resolved maker, or `undefined` in read-only mode.
   * @throws The sanitized signer-construction failure when lazy keystore or KMS resolution fails.
   * @remarks Lazy resolution may read a keystore or call KMS, but performs no signing or chain write.
   */
  async getDerivedMaker() {
    if ('deriveSignerAddress' in this.options) return this.options.deriveSignerAddress()
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
   * Cross-checks a ratifier against the SDK catalog, exact runtime hash, immutable target, callable
   * Ecrecover or Setter surface, and Midnight authorization.
   * @param maker - Maker whose authorization/root surface is read.
   * @param ratifier - Candidate ratifier address.
   * @returns Sanitized ratifier type and five readiness facts without exposing provider URLs or bytecode.
   * @throws `ProviderReadError` on a sanitized RPC rejection, or `ProviderResponseError` for malformed
   * contract responses.
   * @remarks Bytecode and authorization reads start concurrently. Ratifier ABI reads then run
   * concurrently only after the exact selected runtime is proven; this is read-only.
   */
  async getRatifier(maker: Address, ratifier: Address) {
    const [code, authorized] = await Promise.all([
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
    const chainId = this.options.chainId
    const type = isAddressEqual(ratifier, getChainAddress(chainId, 'setterRatifier'))
      ? ('setter' as const)
      : isAddressEqual(ratifier, getChainAddress(chainId, 'ecrecoverRatifier'))
        ? ('ecrecover' as const)
        : undefined
    const listed = type !== undefined
    const deployed = code !== undefined && code !== '0x'
    const expectedRuntimeHash = type === undefined ? undefined : ratifierRuntimeHash(chainId, type)
    const surfaceMatches =
      deployed && expectedRuntimeHash !== undefined && keccak256(code) === expectedRuntimeHash
    if (!surfaceMatches || type === undefined) {
      return {
        type,
        listed,
        deployed,
        midnightMatches: false,
        surfaceMatches: false,
        authorized
      }
    }
    const abi = type === 'setter' ? setterRatifierAbi : ecrecoverRatifierAbi
    const rootFunction = type === 'setter' ? 'isRootRatified' : 'isRootCanceled'
    const [ratifierMidnight, rootState] = await Promise.all([
      executeProviderRead('rpc', 'ratifier-midnight', () =>
        this.chain.readContract({
          address: ratifier,
          abi,
          functionName: 'MIDNIGHT'
        })
      ),
      executeProviderRead('rpc', 'ratifier-root', () =>
        this.chain.readContract({
          address: ratifier,
          abi,
          functionName: rootFunction,
          args: [maker, zeroHash]
        })
      )
    ])
    if (typeof ratifierMidnight !== 'string' || !isAddress(ratifierMidnight)) {
      throw new ProviderResponseError(
        'rpc',
        'ratifier-midnight',
        `${type === 'setter' ? 'SetterRatifier' : 'EcrecoverRatifier'} MIDNIGHT response must be an address`
      )
    }
    if (typeof rootState !== 'boolean') {
      throw new ProviderResponseError(
        'rpc',
        'ratifier-root',
        `${type === 'setter' ? 'SetterRatifier isRootRatified' : 'EcrecoverRatifier isRootCanceled'} response must be boolean`
      )
    }
    return {
      type,
      listed,
      deployed,
      midnightMatches: isAddressEqual(ratifierMidnight, this.options.midnight),
      surfaceMatches,
      authorized
    }
  }

  /**
   * Cross-checks one Midnight market between the Morpho API and on-chain state.
   * @param id - Configured market ID.
   * @returns Validated listing, activity, loan asset, and tick spacing.
   * @throws `ProviderReadError` on a sanitized API/RPC rejection, or `ProviderResponseError` when
   * the market registry omits the configured market, or for malformed values, identity
   * disagreement, or invalid chain data.
   * @remarks Market registry, market, and tick-spacing reads run concurrently through
   * `Promise.all`; no writes. Facts come from the documented markets endpoint rather than the books
   * endpoint, which excludes past maturities even when specific IDs are requested, so a configured
   * market that reached maturity is still observable here.
   */
  async getBook(id: Hex): Promise<BookSetup> {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const chainId = this.options.chainId
    const listingQuery = new URLSearchParams({
      chain_ids: String(chainId),
      market_ids: id,
      limit: String(PAGE_SIZE)
    })
    const [listingResponse, contractResponse, tickSpacing] = await Promise.all([
      executeProviderRead('morpho-api', 'market-listing', () =>
        this.request(
          `${this.options.morphoApiBaseUrl}/v0/midnight/markets?${listingQuery.toString()}`,
          'morpho-api',
          requestTimeoutMs
        )
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
    const apiMarket = apiMarkets(listingResponse, chainId).find(market => market.id === id)
    if (apiMarket === undefined) {
      throw new ProviderResponseError(
        'morpho-api',
        'market-count',
        `Morpho API returned no market for ${id}`
      )
    }
    const contractMarket = marketFromContract(contractResponse)
    if (contractMarket.chainId !== BigInt(chainId)) {
      throw new ProviderResponseError(
        'rpc',
        'book-chain',
        'market chain id is not the configured chain'
      )
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
      allowlisted: apiMarket.listed,
      active: true,
      loanAsset: contractMarket.loanToken,
      tickSpacing
    }
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
    const lookback =
      this.options.referenceLookbackBlocks ?? referenceLookbackBlocks(this.options.chainId)
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
          address: getChainAddress(this.options.chainId, 'morpho'),
          abi: blueAbi,
          functionName: 'idToMarketParams',
          args: [this.options.referenceMarketId],
          blockNumber: historicalBlock
        })
      ),
      executeProviderRead('archive-rpc', 'reference-market-state', () =>
        this.reference.readContract({
          address: getChainAddress(this.options.chainId, 'morpho'),
          abi: blueAbi,
          functionName: 'market',
          args: [this.options.referenceMarketId],
          blockNumber: historicalBlock
        })
      )
    ])
    // Morpho's ABI exposes named tuple outputs, which viem decodes as arrays. Reuse the SDK's
    // canonical tuple mapper instead of maintaining positional field mapping locally.
    const params = objectValue(
      Array.isArray(paramsResponse)
        ? restructure(paramsResponse, {
            abi: blueAbi,
            name: 'idToMarketParams',
            args: [this.options.referenceMarketId]
          })
        : paramsResponse,
      'Morpho Blue reference market params'
    )
    const market = objectValue(
      Array.isArray(marketResponse)
        ? restructure(marketResponse, {
            abi: blueAbi,
            name: 'market',
            args: [this.options.referenceMarketId]
          })
        : marketResponse,
      'Morpho Blue reference market state'
    )
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
    if (bigintValue(market.totalSupplyShares, 'reference market totalSupplyShares') === 0n) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market has zero supply shares'
      )
    }
    if (bigintValue(market.lastUpdate, 'reference market lastUpdate') === 0n) {
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
   * @remarks Uses the authoritative cursor-paginated `/users/{maker}/offer-groups` source with an
   * explicit Base chain filter and validates each returned group chain before projecting offers.
   * Pagination is necessarily sequential because each cursor depends on the previous page; only
   * explicit null terminates traversal, and one aggregate absolute deadline covers the whole
   * read-only traversal. midnight-sdk 1.2.0 has no offer-group endpoint/entity, so only this bounded
   * transport and strict response projection remain local.
   */
  async inspectOffers(maker: Address) {
    const offers: ReturnType<typeof offerFromApi>[] = []
    const seenCursors = new Set<string>()
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const now = this.options.now ?? performance.now.bind(performance)
    const deadline = now() + requestTimeoutMs
    let pageCount = 0
    let cursor: string | null = null
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
      const query = new URLSearchParams({
        chain_ids: String(this.options.chainId),
        limit: String(PAGE_SIZE)
      })
      if (cursor !== null) query.set('cursor', cursor)
      const response = objectValue(
        await executeProviderRead('morpho-api', 'offer-groups', () =>
          this.request(
            `${this.options.morphoApiBaseUrl}/v0/midnight/users/${encodeURIComponent(maker)}/offer-groups?${query.toString()}`,
            'morpho-api',
            Math.min(requestTimeoutMs, remainingMs)
          )
        ),
        'Morpho API response'
      )
      const groups = response.data
      if (!Array.isArray(groups)) {
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
      const pageOffers = offersFromGroups(groups, this.options.chainId)
      if (offers.length + pageOffers.length > MAX_OFFER_ITEMS) {
        throw new ProviderPaginationError(
          'morpho-api',
          'item-limit',
          'Morpho API offer item limit exceeded'
        )
      }
      offers.push(...pageOffers)
      if (response.cursor !== null && typeof response.cursor !== 'string') {
        throw new ProviderResponseError(
          'morpho-api',
          'cursor',
          'Morpho API cursor must be a string or null'
        )
      }
      if (typeof response.cursor === 'string' && response.cursor.trim().length === 0) {
        throw new ProviderResponseError(
          'morpho-api',
          'cursor',
          'Morpho API cursor must be a non-empty opaque string or null'
        )
      }
      cursor = typeof response.cursor === 'string' ? response.cursor : null
      if (cursor !== null && seenCursors.has(cursor)) {
        throw new ProviderPaginationError(
          'morpho-api',
          'repeated-cursor',
          'Morpho API cursor repeated'
        )
      }
      if (cursor !== null) seenCursors.add(cursor)
    } while (cursor !== null)

    if (offers.some(offer => !isAddressEqual(offer.maker, maker))) {
      throw new ProviderResponseError(
        'morpho-api',
        'offer-maker',
        'Morpho API active offer maker does not match requested maker'
      )
    }
    const ignoredGroups = new Set(this.options.ignoredOfferGroupIds ?? [])
    const inspectedOffers = offers.filter(offer => !ignoredGroups.has(offer.group))
    const [ownedGroupIds, bootstrapGroupIds, ladderSellGroupIds] = await Promise.all([
      this.options.readOwnedGroupIds(),
      this.options.readBootstrapGroupIds?.() ?? Promise.resolve([]),
      this.options.readLadderSellGroupIds?.() ?? Promise.resolve([])
    ])
    const knownGroups = new Set([...this.options.v0OfferGroupIds, ...ownedGroupIds])
    const configuredMarkets = new Set(this.options.marketIds)
    return {
      unknownNamespaces: [
        ...new Set(
          inspectedOffers.map(offer => offer.group).filter(group => !knownGroups.has(group))
        )
      ],
      unknownMarketIds: [
        ...new Set(
          inspectedOffers
            .map(offer => offer.marketId)
            .filter(marketId => !configuredMarkets.has(marketId))
        )
      ],
      invertedMarketIds: invertedMarketIds(inspectedOffers, {
        bootstrapBuyGroupIds: new Set([...this.options.v0OfferGroupIds, ...bootstrapGroupIds]),
        ladderSellGroupIds: new Set(ladderSellGroupIds)
      })
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
