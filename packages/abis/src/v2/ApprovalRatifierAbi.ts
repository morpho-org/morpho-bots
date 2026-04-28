export const ApprovalRatifierAbi = [
  {
    type: 'function',
    name: 'approved',
    inputs: [
      { name: 'maker', type: 'address', internalType: 'address' },
      { name: 'root', type: 'bytes32', internalType: 'bytes32' }
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'onRatify',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        internalType: 'struct Offer',
        components: [
          {
            name: 'obligation',
            type: 'tuple',
            internalType: 'struct Obligation',
            components: [
              { name: 'loanToken', type: 'address', internalType: 'address' },
              {
                name: 'collateralParams',
                type: 'tuple[]',
                internalType: 'struct CollateralParams[]',
                components: [
                  { name: 'token', type: 'address', internalType: 'address' },
                  { name: 'lltv', type: 'uint256', internalType: 'uint256' },
                  { name: 'maxLif', type: 'uint256', internalType: 'uint256' },
                  { name: 'oracle', type: 'address', internalType: 'address' }
                ]
              },
              { name: 'maturity', type: 'uint256', internalType: 'uint256' },
              { name: 'rcfThreshold', type: 'uint256', internalType: 'uint256' },
              { name: 'enterGate', type: 'address', internalType: 'address' },
              { name: 'liquidatorGate', type: 'address', internalType: 'address' }
            ]
          },
          { name: 'buy', type: 'bool', internalType: 'bool' },
          { name: 'maker', type: 'address', internalType: 'address' },
          { name: 'start', type: 'uint256', internalType: 'uint256' },
          { name: 'expiry', type: 'uint256', internalType: 'uint256' },
          { name: 'tick', type: 'uint256', internalType: 'uint256' },
          { name: 'group', type: 'bytes32', internalType: 'bytes32' },
          { name: 'session', type: 'bytes32', internalType: 'bytes32' },
          { name: 'callback', type: 'address', internalType: 'address' },
          { name: 'callbackData', type: 'bytes', internalType: 'bytes' },
          { name: 'receiverIfMakerIsSeller', type: 'address', internalType: 'address' },
          { name: 'ratifier', type: 'address', internalType: 'address' },
          { name: 'reduceOnly', type: 'bool', internalType: 'bool' },
          { name: 'maxUnits', type: 'uint256', internalType: 'uint256' },
          { name: 'maxSellerAssets', type: 'uint256', internalType: 'uint256' },
          { name: 'maxBuyerAssets', type: 'uint256', internalType: 'uint256' }
        ]
      },
      { name: 'root', type: 'bytes32', internalType: 'bytes32' },
      { name: '', type: 'bytes', internalType: 'bytes' }
    ],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'setApproval',
    inputs: [
      { name: 'root', type: 'bytes32', internalType: 'bytes32' },
      { name: 'newApproval', type: 'bool', internalType: 'bool' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'event',
    name: 'SetApproval',
    inputs: [
      { name: 'maker', type: 'address', indexed: true, internalType: 'address' },
      { name: 'root', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'newApproval', type: 'bool', indexed: false, internalType: 'bool' }
    ],
    anonymous: false
  }
] as const
