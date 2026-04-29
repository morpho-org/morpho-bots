export const MorphoVaultV1AdapterFactoryAbi = [
  {
    type: 'function',
    name: 'createMorphoVaultV1Adapter',
    inputs: [
      { name: 'parentVault', type: 'address', internalType: 'address' },
      { name: 'morphoVaultV1', type: 'address', internalType: 'address' }
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'isMorphoVaultV1Adapter',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'morphoVaultV1Adapter',
    inputs: [
      { name: 'parentVault', type: 'address', internalType: 'address' },
      { name: 'morphoVaultV1', type: 'address', internalType: 'address' }
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'event',
    name: 'CreateMorphoVaultV1Adapter',
    inputs: [
      {
        name: 'parentVault',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'morphoVaultV1',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'morphoVaultV1Adapter',
        type: 'address',
        indexed: true,
        internalType: 'address'
      }
    ],
    anonymous: false
  }
] as const
