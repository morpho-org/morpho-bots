import type { Address, Hex } from 'viem'

import { formatLiquidationId } from '@repo/bot-kit'

export const DOMAIN = 'midnight'
const OP = 'unhealthy-positions'

export const formatOpportunityId = (chainId: number, marketId: Hex, borrower: Address) =>
  formatLiquidationId(DOMAIN, OP, chainId, marketId, borrower)
