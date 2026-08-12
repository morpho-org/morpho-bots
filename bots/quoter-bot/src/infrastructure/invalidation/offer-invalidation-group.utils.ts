import type { Hex } from 'viem'

import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'

/**
 * Selects every indexed active or durably owned pending group for bulk invalidation.
 * @param groups - Current eventually consistent maker groups.
 * @param bootstrapGroupIds - Reserved and confirmed bootstrap ownership IDs.
 * @param ladderGroupIds - Reserved and confirmed ladder ownership IDs.
 * @returns Distinct cancellation candidates, including groups not indexed by the API yet.
 */
export const offerInvalidationGroupIds = (
  groups: readonly BootstrapRawGroup[],
  bootstrapGroupIds: readonly Hex[],
  ladderGroupIds: readonly Hex[]
) => [
  ...new Set([
    ...groups.filter(group => group.maxAssets > group.consumed).map(group => group.id),
    ...bootstrapGroupIds,
    ...ladderGroupIds
  ])
]
