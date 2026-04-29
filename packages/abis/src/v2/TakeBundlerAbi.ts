export const TakeBundlerAbi = [
  {
    type: 'function',
    name: 'bundleTakeBuyerAssets',
    inputs: [
      { name: 'midnight', type: 'address', internalType: 'contract Midnight' },
      { name: 'targetBuyerAssets', type: 'uint256', internalType: 'uint256' },
      { name: 'taker', type: 'address', internalType: 'address' },
      { name: 'receiverIfTakerIsSeller', type: 'address', internalType: 'address' },
      {
        name: 'takes',
        type: 'tuple[]',
        internalType: 'struct TakeBundler.Take[]',
        components: [
          { name: 'units', type: 'uint256', internalType: 'uint256' },
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
          { name: 'sig', type: 'bytes', internalType: 'bytes' },
          { name: 'root', type: 'bytes32', internalType: 'bytes32' },
          { name: 'proof', type: 'bytes32[]', internalType: 'bytes32[]' }
        ]
      },
      { name: 'minUnits', type: 'uint256', internalType: 'uint256' },
      { name: 'maxUnits', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'bundleTakeSellerAssets',
    inputs: [
      { name: 'midnight', type: 'address', internalType: 'contract Midnight' },
      { name: 'targetSellerAssets', type: 'uint256', internalType: 'uint256' },
      { name: 'taker', type: 'address', internalType: 'address' },
      { name: 'receiverIfTakerIsSeller', type: 'address', internalType: 'address' },
      {
        name: 'takes',
        type: 'tuple[]',
        internalType: 'struct TakeBundler.Take[]',
        components: [
          { name: 'units', type: 'uint256', internalType: 'uint256' },
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
          { name: 'sig', type: 'bytes', internalType: 'bytes' },
          { name: 'root', type: 'bytes32', internalType: 'bytes32' },
          { name: 'proof', type: 'bytes32[]', internalType: 'bytes32[]' }
        ]
      },
      { name: 'minUnits', type: 'uint256', internalType: 'uint256' },
      { name: 'maxUnits', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'bundleTakeUnits',
    inputs: [
      { name: 'midnight', type: 'address', internalType: 'contract Midnight' },
      { name: 'targetUnits', type: 'uint256', internalType: 'uint256' },
      { name: 'taker', type: 'address', internalType: 'address' },
      { name: 'receiverIfTakerIsSeller', type: 'address', internalType: 'address' },
      {
        name: 'takes',
        type: 'tuple[]',
        internalType: 'struct TakeBundler.Take[]',
        components: [
          { name: 'units', type: 'uint256', internalType: 'uint256' },
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
          { name: 'sig', type: 'bytes', internalType: 'bytes' },
          { name: 'root', type: 'bytes32', internalType: 'bytes32' },
          { name: 'proof', type: 'bytes32[]', internalType: 'bytes32[]' }
        ]
      },
      { name: 'minBuyerAssets', type: 'uint256', internalType: 'uint256' },
      { name: 'maxBuyerAssets', type: 'uint256', internalType: 'uint256' },
      { name: 'minSellerAssets', type: 'uint256', internalType: 'uint256' },
      { name: 'maxSellerAssets', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  }
] as const
