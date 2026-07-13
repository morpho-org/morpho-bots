import type { Address, Hex } from 'viem'

import { formatLiquidationId } from '@repo/pipeline'

export const DOMAIN = 'midnight'
const OP = 'unhealthy-positions'

export const formatPositionId = (chainId: number, marketId: Hex, borrower: Address) =>
  formatLiquidationId(DOMAIN, OP, chainId, marketId, borrower)
