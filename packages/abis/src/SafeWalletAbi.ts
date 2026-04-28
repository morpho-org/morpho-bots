export const SafeWalletAbi = [
  {
    type: 'function',
    name: 'getThreshold',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'getOwners',
    inputs: [],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view'
  }
] as const
