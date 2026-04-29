export const MorphoMarketV1AdapterFactoryAbi = [
  {
    type: 'function',
    name: 'createMorphoMarketV1Adapter',
    inputs: [
      { name: 'parentVault', type: 'address', internalType: 'address' },
      { name: 'morpho', type: 'address', internalType: 'address' }
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'isMorphoMarketV1Adapter',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'morphoMarketV1Adapter',
    inputs: [
      { name: 'parentVault', type: 'address', internalType: 'address' },
      { name: 'morpho', type: 'address', internalType: 'address' }
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'event',
    name: 'CreateMorphoMarketV1Adapter',
    inputs: [
      {
        name: 'parentVault',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'morpho',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'morphoMarketV1Adapter',
        type: 'address',
        indexed: true,
        internalType: 'address'
      }
    ],
    anonymous: false
  }
] as const
