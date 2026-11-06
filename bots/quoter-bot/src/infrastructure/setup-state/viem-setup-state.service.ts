import type { Address, Hex } from 'viem'

import { ecrecoverRatifierAbi, midnightAbi, setterRatifierAbi } from '@morpho-org/midnight-sdk'
import { blueAbi } from '@morpho-org/morpho-sdk/abis'
import { restructure } from '@morpho-org/morpho-sdk/utils'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { blockTimeMs } from '@repo/kit'
import {
  erc20Abi,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  zeroHash
} from 'viem'

import type {
  BookSetup,
  LoanCollateralSetup,
  SetupStateService
} from '../../application/setup/setup-check.service'
import type { SupportedChainId } from '../../config/supported-chains.utils'
import type { JsonRequest } from '../provider/http-json.utils'

import { ratifierRuntimeHash, ratifierType } from '../../config/supported-chains.utils'
import { ProviderResponseError, OfferGroupsReadError } from '../../errors'
import { findBlockAtOrBefore } from '../provider/historical-block.utils'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'
import { executeProviderRead } from '../provider/provider-read.utils'
import {
  addressValue,
  apiMarkets,
  borrowTermsFromContract,
  DEFAULT_REQUEST_TIMEOUT_MS,
  invertedMarketIds,
  marketFromContract,
  objectValue,
  PAGE_SIZE,
  bigintValue,
  uint128Value
} from './viem-setup-state.utils'

const enterGateAbi = parseAbi(['function canIncreaseDebt(address account) view returns (bool)'])

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
  /** Groups the kernel withdrew, whose offers a lagging index may still list. */
  readWithdrawnGroupIds?: () => Promise<readonly Hex[]>
  readBootstrapGroupIds?: () => Promise<readonly Hex[]>
  readLadderSellGroupIds?: () => Promise<readonly Hex[]>
  referenceMarketId: Hex
  referenceLookbackSeconds: bigint
  requestTimeoutMs?: number
} & ({ readOnly: true } | { readOnly?: false; deriveSignerAddress: () => Promise<Address> })

/** Read-only viem/API adapter that gathers setup facts and validates provider agreement. */
export class ViemSetupStateService implements SetupStateService {
  /**
   * Creates a state adapter that derives the signer only when write authority is configured.
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
  ) {}

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
   * @returns The lazily resolved signer, or `undefined` in read-only mode.
   * @throws The sanitized signer-construction failure when lazy keystore or KMS resolution fails.
   * @remarks Lazy resolution may read a keystore or call KMS, but performs no signing or chain write.
   */
  async getDerivedSigner() {
    return 'deriveSignerAddress' in this.options ? this.options.deriveSignerAddress() : undefined
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
   * Reads one maker-to-delegate Midnight authorization.
   * @param maker - Funded principal granting authority.
   * @param delegate - Address whose authority is checked.
   * @returns Whether the delegate is authorized for the maker.
   */
  async getAuthorization(maker: Address, delegate: Address) {
    const authorized = await executeProviderRead('rpc', 'signer-authorization', () =>
      this.chain.readContract({
        address: this.options.midnight,
        abi: midnightAbi,
        functionName: 'isAuthorized',
        args: [maker, delegate]
      })
    )
    if (typeof authorized !== 'boolean') {
      throw new ProviderResponseError(
        'rpc',
        'signer-authorization',
        'Midnight isAuthorized response must be boolean'
      )
    }
    return authorized
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
    const type = ratifierType(ratifier, chainId)
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
   * Cross-checks one Midnight Market between the Morpho API and onchain state.
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
    const historical = await findBlockAtOrBefore({
      latest: { number: latest.number, timestamp: latest.timestamp },
      target: latest.timestamp - this.options.referenceLookbackSeconds,
      getBlock: blockNumber =>
        executeProviderRead('archive-rpc', 'reference-historical-block', () =>
          this.reference.getBlock({ blockNumber })
        ),
      blockTimeMs: blockTimeMs(this.options.chainId)
    })
    if (historical === undefined) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-history',
        'reference RPC has insufficient history'
      )
    }
    const historicalBlock = historical.number
    const [paramsResponse, marketResponse, latestMarketResponse] = await Promise.all([
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
      ),
      executeProviderRead('archive-rpc', 'reference-latest-market-state', () =>
        this.reference.readContract({
          address: getChainAddress(this.options.chainId, 'morpho'),
          abi: blueAbi,
          functionName: 'market',
          args: [this.options.referenceMarketId],
          blockNumber: latest.number
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
    const latestMarket = objectValue(
      Array.isArray(latestMarketResponse)
        ? restructure(latestMarketResponse, {
            abi: blueAbi,
            name: 'market',
            args: [this.options.referenceMarketId]
          })
        : latestMarketResponse,
      'Morpho Blue latest reference market state'
    )
    const referenceLoanAsset = addressValue(params.loanToken, 'reference market loanToken')
    if (referenceLoanAsset === zeroAddress) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market does not exist at the start of the configured window'
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
        'configured reference market had no supply shares at the start of the configured window'
      )
    }
    if (bigintValue(market.lastUpdate, 'reference market lastUpdate') === 0n) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-market',
        'configured reference market was uninitialized at the start of the configured window'
      )
    }
    // The rate reader applies this predicate to both of its checkpoints, so validating only the
    // historical one would report ready and then reject the first runtime read of a market that has
    // since been fully withdrawn.
    if (
      bigintValue(latestMarket.totalSupplyShares, 'latest reference market totalSupplyShares') ===
        0n ||
      bigintValue(latestMarket.lastUpdate, 'latest reference market lastUpdate') === 0n
    ) {
      throw new ProviderResponseError(
        'archive-rpc',
        'reference-latest-market',
        'configured reference market currently has no supply shares'
      )
    }
    return {
      marketId: this.options.referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }
  }

  /**
   * Reads every active offer group for a maker through {@link readMakerOfferGroups} and detects
   * unknown groups, unconfigured markets, or crossed books, including fresh offers whose takeable
   * amount has not been measured yet.
   * @param maker - Maker whose complete active offer-group set is inspected.
   * @returns Deduplicated unknown namespaces, unconfigured markets, and all crossed market IDs.
   * @throws `ProviderResponseError` naming the failed offer-group operation, or what the request
   * throws.
   * @remarks Read-only: no writes. One aggregate absolute deadline of `requestTimeoutMs` covers the
   * whole traversal of every page.
   */
  async inspectOffers(maker: Address) {
    const groups = await readMakerOfferGroups(
      {
        adapterError: OfferGroupsReadError,
        chainId: this.options.chainId,
        maker,
        requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        morphoApiBaseUrl: this.options.morphoApiBaseUrl
      },
      {
        request: (url, provider, timeoutMs) =>
          executeProviderRead('morpho-api', 'offer-groups', () =>
            this.request(url, provider, timeoutMs)
          )
      }
    )
    const offers = groups.flatMap(group =>
      group.offers.map(offer => ({ ...offer, group: group.id }))
    )
    const [withdrawnGroupIds, ownedGroupIds, bootstrapGroupIds, ladderSellGroupIds] =
      await Promise.all([
        this.options.readWithdrawnGroupIds?.() ?? Promise.resolve([]),
        this.options.readOwnedGroupIds(),
        this.options.readBootstrapGroupIds?.() ?? Promise.resolve([]),
        this.options.readLadderSellGroupIds?.() ?? Promise.resolve([])
      ])
    const withdrawn = new Set(withdrawnGroupIds.map(groupId => groupId.toLowerCase()))
    const inspectedOffers = offers.filter(offer => !withdrawn.has(offer.group.toLowerCase()))
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
   * Reads the maker's face debt in one market.
   * @param id - Configured market ID.
   * @param maker - Maker whose position is read.
   * @returns The debt as a uint128.
   * @throws `ProviderReadError` on a sanitized RPC rejection, or `ProviderResponseError` when the
   * response is not a uint128.
   * @remarks Read-only; performs no writes.
   */
  async getDebt(id: Hex, maker: Address) {
    const debt = await executeProviderRead('rpc', 'position-debt', () =>
      this.chain.readContract({
        address: this.options.midnight,
        abi: midnightAbi,
        functionName: 'debt',
        args: [id, maker]
      })
    )
    return uint128Value(debt, 'position-debt')
  }

  /**
   * Reads the collateral slot of one market whose token is the market's loan asset.
   * @param id - Configured market ID.
   * @param maker - Maker whose collateral and enter-gate answer are read.
   * @returns The maker's collateral in the slot, its LLTV and oracle runtime hash, whether the enter
   * gate lets the maker borrow, and whether the market has matured; `undefined` without such a slot.
   * @throws `ProviderReadError` on a sanitized RPC rejection, including a gate that reverts, or
   * `ProviderResponseError` for a malformed response.
   * @remarks Read-only; performs no writes. The gate is asked on every check: its address is
   * immutable, but its answer is not.
   */
  async getLoanCollateral(id: Hex, maker: Address): Promise<LoanCollateralSetup | undefined> {
    const [market, block] = await Promise.all([
      executeProviderRead('rpc', 'borrow-market', () =>
        this.chain.readContract({
          address: this.options.midnight,
          abi: midnightAbi,
          functionName: 'toMarket',
          args: [id]
        })
      ),
      executeProviderRead('rpc', 'borrow-block', () => this.chain.getBlock({ blockTag: 'latest' }))
    ])
    const terms = borrowTermsFromContract(market)
    if (terms.loanSlot === undefined) return undefined
    const { loanSlot } = terms
    const [assets, oracleCode, enterGateOpen] = await Promise.all([
      executeProviderRead('rpc', 'loan-collateral', () =>
        this.chain.readContract({
          address: this.options.midnight,
          abi: midnightAbi,
          functionName: 'collateral',
          args: [id, maker, loanSlot.index]
        })
      ),
      executeProviderRead('rpc', 'loan-collateral-oracle', () =>
        this.chain.getCode({ address: loanSlot.oracle })
      ),
      isAddressEqual(terms.enterGate, zeroAddress)
        ? true
        : executeProviderRead('rpc', 'enter-gate', () =>
            this.chain.readContract({
              address: terms.enterGate,
              abi: enterGateAbi,
              functionName: 'canIncreaseDebt',
              args: [maker]
            })
          )
    ])
    if (typeof enterGateOpen !== 'boolean') {
      throw new ProviderResponseError(
        'rpc',
        'enter-gate',
        'enter gate canIncreaseDebt response must be a boolean'
      )
    }
    return {
      assets: uint128Value(assets, 'loan-collateral'),
      lltv: loanSlot.lltv,
      oracleRuntimeHash:
        oracleCode === undefined || oracleCode === '0x' ? undefined : keccak256(oracleCode),
      enterGateOpen,
      matured: block.timestamp > terms.maturity
    }
  }
}
