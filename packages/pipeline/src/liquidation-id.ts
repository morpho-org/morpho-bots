import type { Address, Hex } from 'viem'

export function formatLiquidationId(
  domain: string,
  op: string,
  chainId: number,
  marketId: Hex,
  borrower: Address
): string {
  return `${domain}:${op}:${chainId}:${marketId.toLowerCase()}:${borrower.toLowerCase()}`
}
