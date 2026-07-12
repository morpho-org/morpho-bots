import type { Address } from 'viem'

import { isAddressEqual, zeroAddress } from 'viem'

export function isNonZeroAddress(address: Address): boolean {
  return !isAddressEqual(address, zeroAddress)
}
