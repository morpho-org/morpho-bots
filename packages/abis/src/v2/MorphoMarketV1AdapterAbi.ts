export const MorphoMarketV1AdapterAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_parentVault', type: 'address', internalType: 'address' },
      { name: '_morpho', type: 'address', internalType: 'address' }
    ],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'adapterId',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'allocate',
    inputs: [
      { name: 'data', type: 'bytes', internalType: 'bytes' },
      { name: 'assets', type: 'uint256', internalType: 'uint256' },
      { name: '', type: 'bytes4', internalType: 'bytes4' },
      { name: '', type: 'address', internalType: 'address' }
    ],
    outputs: [
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      { name: '', type: 'int256', internalType: 'int256' }
    ],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'allocation',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        internalType: 'struct MarketParams',
        components: [
          { name: 'loanToken', type: 'address', internalType: 'address' },
          { name: 'collateralToken', type: 'address', internalType: 'address' },
          { name: 'oracle', type: 'address', internalType: 'address' },
          { name: 'irm', type: 'address', internalType: 'address' },
          { name: 'lltv', type: 'uint256', internalType: 'uint256' }
        ]
      }
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'deallocate',
    inputs: [
      { name: 'data', type: 'bytes', internalType: 'bytes' },
      { name: 'assets', type: 'uint256', internalType: 'uint256' },
      { name: '', type: 'bytes4', internalType: 'bytes4' },
      { name: '', type: 'address', internalType: 'address' }
    ],
    outputs: [
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      { name: '', type: 'int256', internalType: 'int256' }
    ],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'ids',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        internalType: 'struct MarketParams',
        components: [
          { name: 'loanToken', type: 'address', internalType: 'address' },
          { name: 'collateralToken', type: 'address', internalType: 'address' },
          { name: 'oracle', type: 'address', internalType: 'address' },
          { name: 'irm', type: 'address', internalType: 'address' },
          { name: 'lltv', type: 'uint256', internalType: 'uint256' }
        ]
      }
    ],
    outputs: [{ name: '', type: 'bytes32[]', internalType: 'bytes32[]' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'marketParamsList',
    inputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      { name: 'loanToken', type: 'address', internalType: 'address' },
      { name: 'collateralToken', type: 'address', internalType: 'address' },
      { name: 'oracle', type: 'address', internalType: 'address' },
      { name: 'irm', type: 'address', internalType: 'address' },
      { name: 'lltv', type: 'uint256', internalType: 'uint256' }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'marketParamsListLength',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'morpho',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'parentVault',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'realAssets',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'setSkimRecipient',
    inputs: [{ name: 'newSkimRecipient', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'skim',
    inputs: [{ name: 'token', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'skimRecipient',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view'
  },
  {
    type: 'event',
    name: 'SetSkimRecipient',
    inputs: [
      {
        name: 'newSkimRecipient',
        type: 'address',
        indexed: true,
        internalType: 'address'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Skim',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'assets',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  { type: 'error', name: 'ApproveReturnedFalse', inputs: [] },
  { type: 'error', name: 'ApproveReverted', inputs: [] },
  { type: 'error', name: 'LoanAssetMismatch', inputs: [] },
  { type: 'error', name: 'NoCode', inputs: [] },
  { type: 'error', name: 'NotAuthorized', inputs: [] },
  { type: 'error', name: 'TransferReturnedFalse', inputs: [] },
  { type: 'error', name: 'TransferReverted', inputs: [] }
] as const
