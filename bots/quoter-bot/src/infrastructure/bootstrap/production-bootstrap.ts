import { Tree, type TreeCreateParams } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { midnightTreeWitness } from '@repo/validators'
import { createPublicClient, http, type Hex } from 'viem'

import type { WorldOwnership } from '../../application/engine/world'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { WorldReads } from '../engine/world-reads'

import { prepareBootstrap } from '../../application/engine/bootstrap-preparation'
import { supportedChain } from '../../config/supported-chains.utils'
import { remainingBuyAssets } from '../../domain/offer-cap'
import { BootstrapAdapterError } from '../../errors'
import { readPreparation } from '../engine/quoter-sources'
import {
  validateBootstrapMempoolPayload,
  validateBootstrapMempoolPublication
} from './bootstrap-mempool-validation.utils'

/**
 * The loan assets a bootstrap offer can spend, which `makeLend` reserves.
 * @param units - The offer's `maxUnits`.
 * @param tick - The offer's final protocol tick.
 * @returns The {@link remainingBuyAssets} bound of the units cap at `tick`, floored at one because
 * `makeLend` rejects zero.
 */
export const bootstrapLoanAssets = (units: bigint, tick: bigint) => {
  const assets = remainingBuyAssets({ kind: 'units', maximum: units }, 0n, [tick])
  return assets > 0n ? assets : 1n
}

/** The exact offer one bootstrap replacement publishes, or keeps when a live group already matches. */
export type BootstrapPreparation = {
  /** The resolved offer; absent when owned ladder liquidity covers it or no clear tick fits. */
  offer?: BootstrapOffer
  /** A live group whose remaining cap, tick, and fee cap already match, kept instead. */
  retainedGroupId?: Hex
  publication?: {
    groupId: Hex
    tick: bigint
    continuousFeeCap?: bigint
    witness: TreeCreateParams
  }
}

/** The bootstrap's publication preparation and its post-ratification check. */
export type BootstrapAdapters = {
  /**
   * Prepares the offer that replaces a market's bootstrap groups.
   * @throws When the book, projection, or `makeLend` validation cannot prove a safe publication.
   */
  prepareReplacement: (parameters: {
    marketId: Hex
    /** The world block the decision read; no older head is prepared at. */
    block: number
    desiredOffer: BootstrapOffer
    /** What the maker holds as the preparation starts. */
    ownership: WorldOwnership
  }) => Promise<BootstrapPreparation>
  /** Checks a Setter publication's exact payload after its ratification lands. */
  validateRatified: (payload: Hex) => Promise<void>
}

/**
 * Composes the bootstrap's publication preparation over its own fresh read.
 * @param config - Fully validated runtime configuration.
 * @param context - The world reads a preparation makes.
 * @returns The bootstrap's preparation and ratified-payload validation adapters.
 * @remarks No provider request occurs while this function constructs the adapters.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService,
  context: { reads: WorldReads }
): BootstrapAdapters => {
  const maker = config.identity.maker
  const midnight = createPublicClient({
    chain: supportedChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
    .morpho.midnight(config.chainId)
  const apiUrl = `${config.morphoApiBaseUrl}/v0/midnight`

  /**
   * Resolves the exact offer a bootstrap replacement would publish, against the complete book, as
   * if the market's groups were already cancelled, and validates it through `makeLend`.
   */
  const prepareReplacement: BootstrapAdapters['prepareReplacement'] = async request => {
    const bounds = config.bootstrap.find(item => item.marketId === request.marketId)
    if (!bounds) throw new BootstrapAdapterError('negative-spread')
    const reading = await readPreparation({
      reads: context.reads,
      ownership: request.ownership,
      marketId: request.marketId,
      atLeastBlock: BigInt(request.block),
      adapterError: BootstrapAdapterError
    })
    const prepared = prepareBootstrap({
      reading,
      request,
      config: bounds,
      maker,
      ratifier: config.setup.ratifier,
      v0OfferGroupIds: config.v0OfferGroupIds
    })
    if (!('created' in prepared)) return prepared
    const { offer, created } = prepared
    const output = await validateBootstrapMempoolPublication(() =>
      midnight.makeLend({
        accountAddress: maker,
        offers: [created],
        validation: { apiUrl },
        loanToken: config.setup.loanAsset,
        loanAssets: bootstrapLoanAssets(offer.assets, created.tick),
        reservedLoanAssets: prepared.reservedLoanAssets
      })
    )
    const tree = Tree.create([created])
    if (tree.root !== output.root) throw new BootstrapAdapterError('unexpected-requirement')
    return {
      offer,
      publication: {
        groupId: output.groups[0] as Hex,
        tick: created.tick,
        ...(created.continuousFeeCap === undefined
          ? {}
          : { continuousFeeCap: created.continuousFeeCap }),
        witness: midnightTreeWitness(tree)
      }
    }
  }

  return {
    prepareReplacement,
    validateRatified: payload =>
      validateBootstrapMempoolPayload({ chainId: config.chainId, baseUrl: apiUrl, payload })
  }
}
