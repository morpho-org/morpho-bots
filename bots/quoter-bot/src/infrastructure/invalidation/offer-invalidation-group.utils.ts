import type { Hex } from 'viem'

import type { MakerOfferGroup } from '../provider/offer-groups.utils'

import { isGroupClosed } from '../../domain/offer-cap'

/**
 * Selects every indexed active or durably owned pending group for bulk invalidation.
 * @param groups - Current eventually consistent maker groups.
 * @param bootstrapGroupIds - Reserved and confirmed bootstrap ownership IDs.
 * @param ladderGroupIds - Reserved and confirmed ladder ownership IDs.
 * @returns Distinct cancellation candidates, including groups not indexed by the API yet.
 */
export const offerInvalidationGroupIds = (
  groups: readonly MakerOfferGroup[],
  bootstrapGroupIds: readonly Hex[],
  ladderGroupIds: readonly Hex[]
) => [
  ...new Set([
    ...groups
      .filter(
        group =>
          !isGroupClosed(
            { cap: group.cap, buy: group.offers.some(offer => offer.buy) },
            group.consumed
          )
      )
      .map(group => group.id),
    ...bootstrapGroupIds,
    ...ladderGroupIds
  ])
]
