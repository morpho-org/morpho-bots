import { Address, checksumAddress, isAddress, isAddressEqual, zeroAddress } from 'viem'

export function isNonZeroAddress(address: Address): boolean {
  return !isAddressEqual(address, zeroAddress)
}

export function abbreviateAddress(address: string, segLength = 4) {
  if (!address) return ''
  if (isAddress(address)) address = checksumAddress(address)
  const firstSegment = address.substring(0, segLength + 2)
  const lastSegment = address.substring(address.length, address.length - segLength)
  return `${firstSegment}...${lastSegment}`
}
