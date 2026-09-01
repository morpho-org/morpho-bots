import { createColumnHelper } from '@tanstack/react-table'

import type { AssetFormatter, LadderGraphicModel } from './model'

const columnHelper = createColumnHelper<LadderGraphicModel['rungs'][number]>()

/**
 * Renders one display amount while keeping its exact raw integer reachable.
 * @param rawAmount - Exact raw integer amount as configured and exported.
 * @param display - Scaled amount to show in its place.
 * @returns A span carrying the display amount, with the raw integer on hover and in
 * `data-raw-amount` so the rounded rendering never hides the configured value.
 */
export const amountCell = (rawAmount: string, display: string) => (
  <span title={rawAmount} data-raw-amount={rawAmount}>
    {display}
  </span>
)

/**
 * Builds the rung table columns for one display scale.
 * @param format - Current display formatter for configured amounts.
 * @returns Column definitions pairing each rate with its allocation and offer cap, both scaled for
 * reading and both retaining their raw integers.
 */
export const rungColumnsFor = (format: AssetFormatter) => [
  columnHelper.accessor('sideLabel', { header: 'Side', cell: info => info.getValue() }),
  columnHelper.accessor('rateBps', { header: 'Rate (BPS)', cell: info => info.getValue() }),
  columnHelper.accessor('allocationAssets', {
    header: 'Allocation',
    cell: info => amountCell(info.getValue(), format(info.getValue()))
  }),
  columnHelper.accessor('offerMaxAssets', {
    header: 'Offer cap',
    cell: info => amountCell(info.getValue(), format(info.getValue()))
  })
]
