import type { Address, Hex } from 'viem'

import { formatLiquidationId } from '@repo/pipeline'

export const DOMAIN = 'blue'
const OP = 'unhealthy-positions'

export const formatOpportunityId = (chainId: number, marketId: Hex, borrower: Address) =>
  formatLiquidationId(DOMAIN, OP, chainId, marketId, borrower)
