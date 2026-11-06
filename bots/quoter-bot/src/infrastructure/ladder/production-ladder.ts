import type { Tree, TreeCreateParams } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { midnightTreeWitness } from '@repo/validators'

import type { WorldOwnership } from '../../application/engine/world'
import type { LadderBookReconciliation } from '../../application/ladder/ladder-verbose'
import type { ConfigService } from '../../config/config.service'
import type { LadderQuoteSet, LadderWithdrawnSide } from '../../domain/ladder'
import type { WorldReads } from '../engine/world-reads'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { prepareLadder } from '../../application/engine/ladder-preparation'
import { LadderAdapterError } from '../../errors'
import { readPreparation } from '../engine/quoter-sources'

/** What one ladder replacement publishes, prepared against the complete book before any cancel. */
export type LadderPreparation = {
  reconciliation: LadderBookReconciliation
  bookClearedRungs?: { lower: number; higher: number }
  withdrawnSides?: readonly LadderWithdrawnSide[]
  /** Absent when every side was withdrawn at the publication block. */
  publication?: {
    quote: LadderQuoteSet
    groups: readonly LadderGroupReference[]
    witness: TreeCreateParams
  }
}

/** The ladder's publication preparation and its post-ratification check. */
export type LadderAdapters = {
  /**
   * Prepares the exact tree that replaces a market's live ladder: reads the complete book, rechecks
   * a `book-crossed` crossing, builds the unsigned tree, asserts its prospective spread, and
   * API-validates it, as if the replaced groups were already cancelled.
   * @throws When the reading, the book, or validation cannot prove a safe publication.
   */
  prepareReplacement: (parameters: {
    marketId: Hex
    /** The world block the decision read; no older head is prepared at. */
    block: number
    desired: LadderQuoteSet
    reason: 'publish' | 'recenter' | 'resize' | 'book-crossed'
    bookCrossedSides?: readonly ('lower' | 'higher')[]
    /** What the maker holds as the preparation starts. */
    ownership: WorldOwnership
  }) => Promise<LadderPreparation>
  /** Checks a Setter publication's tree against the API after its ratification lands. */
  validateRatified: (tree: Tree) => Promise<void>
}

/**
 * Composes the ladder's publication preparation over its own fresh read.
 * @param config - Fully validated runtime configuration.
 * @param context - The world reads a preparation makes.
 * @returns The ladder's preparation and ratified-tree validation adapters.
 * @remarks Every prepared tree is API-validated unsigned; the controller's plans sign and send it
 * through the kernel, and a Setter publication is validated again after its ratification lands.
 */
export const createProductionLadderAdapters = (
  config: ConfigService,
  context: { reads: WorldReads }
): LadderAdapters => {
  const configByMarket = new Map(config.ladder.map(item => [item.marketId, item]))
  const apiUrl = `${config.morphoApiBaseUrl}/v0/midnight`

  const prepareReplacement: LadderAdapters['prepareReplacement'] = async request => {
    const selected = configByMarket.get(request.marketId)
    if (!selected) throw new LadderAdapterError('market-configuration-missing')
    const reading = await readPreparation({
      reads: context.reads,
      ownership: request.ownership,
      marketId: request.marketId,
      atLeastBlock: BigInt(request.block),
      adapterError: LadderAdapterError
    })
    const { publication, ...prepared } = prepareLadder({
      reading,
      request,
      config: selected,
      maker: config.identity.maker,
      ratifier: config.setup.ratifier,
      v0OfferGroupIds: config.v0OfferGroupIds
    })
    if (!publication) return prepared
    const { tree, ...published } = publication
    await tree.mempoolValidate({ chainId: config.chainId, apiUrl })
    return { ...prepared, publication: { ...published, witness: midnightTreeWitness(tree) } }
  }

  /**
   * Checks a Setter publication's exact payload after its ratification lands.
   * @throws `LadderAdapterError('mempool-validation-after-ratification')` when the API rejects it.
   */
  const validateRatified = async (tree: Tree) => {
    try {
      await tree.mempoolValidate({
        chainId: config.chainId,
        apiUrl,
        ratification: { type: 'setter' }
      })
    } catch {
      throw new LadderAdapterError('mempool-validation-after-ratification')
    }
  }

  return { prepareReplacement, validateRatified }
}
