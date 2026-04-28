import type { ContractFunctionName, Hex } from 'viem'

import { type Prettify, type ReverseMapping } from '@repo/utils'

/** Type for function names in the Morpho Market V1 Adapter V2 ABI */
export type MorphoMarketV1AdapterV2FunctionName = ContractFunctionName<
  typeof MorphoMarketV1AdapterV2Abi
>

/** Mapping from selector → name for functions that call `timelocked()` on the adapter */
export const MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_SELECTORS = {
  '0xb2e32848': 'abdicate',
  '0x3b2de5ac': 'burnShares',
  '0x5c1a1a4f': 'decreaseTimelock',
  '0x47966291': 'increaseTimelock',
  '0x2b30997b': 'setSkimRecipient'
} as const satisfies Record<Hex, MorphoMarketV1AdapterV2FunctionName>

type AdapterTimelockSelectorMap = typeof MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_SELECTORS

/** Type for functions that call `timelocked()` on the adapter */
export type MorphoMarketV1AdapterV2TimelockType =
  AdapterTimelockSelectorMap[keyof AdapterTimelockSelectorMap]

/** Mapping from name → selector for functions that call `timelocked()` on the adapter */
export const MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_NAME_TO_SELECTOR = Object.fromEntries(
  Object.entries(MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_SELECTORS).map(([hex, name]) => [name, hex])
) as Prettify<ReverseMapping<typeof MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_SELECTORS>>

/** Ordered array of all timelocked adapter function names */
export const MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_FUNCTIONS = Object.values(
  MORPHO_MARKET_V1_ADAPTER_V2_TIMELOCKED_SELECTORS
) as readonly MorphoMarketV1AdapterV2TimelockType[]

/**
 * Adapter timelocks that have a standalone duration to display and edit. `decreaseTimelock`
 * is omitted because the adapter derives its submit delay from the selector being
 * decreased — it has no timelock of its own.
 */
export const MORPHO_MARKET_V1_ADAPTER_V2_EDITABLE_TIMELOCKS: readonly {
  timelockType: MorphoMarketV1AdapterV2TimelockType
  selector: Hex
}[] = [
  { timelockType: 'abdicate', selector: '0xb2e32848' },
  { timelockType: 'burnShares', selector: '0x3b2de5ac' },
  { timelockType: 'increaseTimelock', selector: '0x47966291' },
  { timelockType: 'setSkimRecipient', selector: '0x2b30997b' }
] as const

export const MorphoMarketV1AdapterV2Abi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_parentVault',
        type: 'address',
        internalType: 'address'
      },
      {
        name: '_morpho',
        type: 'address',
        internalType: 'address'
      },
      {
        name: '_adaptiveCurveIrm',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'adapterId',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'adaptiveCurveIrm',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'allocate',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes'
      },
      {
        name: 'assets',
        type: 'uint256',
        internalType: 'uint256'
      },
      {
        name: '',
        type: 'bytes4',
        internalType: 'bytes4'
      },
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32[]',
        internalType: 'bytes32[]'
      },
      {
        name: '',
        type: 'int256',
        internalType: 'int256'
      }
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
          {
            name: 'loanToken',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'collateralToken',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'irm',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'lltv',
            type: 'uint256',
            internalType: 'uint256'
          }
        ]
      }
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'burnShares',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        internalType: 'bytes32'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'timelock',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        internalType: 'bytes4'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'abdicated',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        internalType: 'bytes4'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'executableAt',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'deallocate',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes'
      },
      {
        name: 'assets',
        type: 'uint256',
        internalType: 'uint256'
      },
      {
        name: '',
        type: 'bytes4',
        internalType: 'bytes4'
      },
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32[]',
        internalType: 'bytes32[]'
      },
      {
        name: '',
        type: 'int256',
        internalType: 'int256'
      }
    ],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'expectedSupplyAssets',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        internalType: 'bytes32'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
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
          {
            name: 'loanToken',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'collateralToken',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'irm',
            type: 'address',
            internalType: 'address'
          },
          {
            name: 'lltv',
            type: 'uint256',
            internalType: 'uint256'
          }
        ]
      }
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32[]',
        internalType: 'bytes32[]'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'marketIds',
    inputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'marketIdsLength',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'morpho',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'parentVault',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'realAssets',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'submit',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'revoke',
    inputs: [
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'increaseTimelock',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        internalType: 'bytes4'
      },
      {
        name: 'newDuration',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'decreaseTimelock',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        internalType: 'bytes4'
      },
      {
        name: 'newDuration',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'abdicate',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        internalType: 'bytes4'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'setSkimRecipient',
    inputs: [
      {
        name: 'newSkimRecipient',
        type: 'address',
        internalType: 'address'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'skim',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address'
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'skimRecipient',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'supplyShares',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        internalType: 'bytes32'
      }
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'event',
    name: 'Allocate',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32'
      },
      {
        name: 'newAllocation',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      },
      {
        name: 'mintedShares',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'BurnShares',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32'
      },
      {
        name: 'supplyShares',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Deallocate',
    inputs: [
      {
        name: 'marketId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32'
      },
      {
        name: 'newAllocation',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      },
      {
        name: 'burnedShares',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Submit',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      },
      {
        name: 'data',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes'
      },
      {
        name: 'executableAt',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Accept',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      },
      {
        name: 'data',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Revoke',
    inputs: [
      {
        name: 'caller',
        type: 'address',
        indexed: true,
        internalType: 'address'
      },
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      },
      {
        name: 'data',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'IncreaseTimelock',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      },
      {
        name: 'newDuration',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'DecreaseTimelock',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      },
      {
        name: 'newDuration',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256'
      }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Abdicate',
    inputs: [
      {
        name: 'selector',
        type: 'bytes4',
        indexed: true,
        internalType: 'bytes4'
      }
    ],
    anonymous: false
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
  {
    type: 'error',
    name: 'DataAlreadyPending',
    inputs: []
  },
  {
    type: 'error',
    name: 'ApproveReturnedFalse',
    inputs: []
  },
  {
    type: 'error',
    name: 'ApproveReverted',
    inputs: []
  },
  {
    type: 'error',
    name: 'IrmMismatch',
    inputs: []
  },
  {
    type: 'error',
    name: 'LoanAssetMismatch',
    inputs: []
  },
  {
    type: 'error',
    name: 'NoCode',
    inputs: []
  },
  {
    type: 'error',
    name: 'Unauthorized',
    inputs: []
  },
  {
    type: 'error',
    name: 'DataNotTimelocked',
    inputs: []
  },
  {
    type: 'error',
    name: 'Abdicated',
    inputs: []
  },
  {
    type: 'error',
    name: 'AutomaticallyTimelocked',
    inputs: []
  },
  {
    type: 'error',
    name: 'TimelockNotIncreasing',
    inputs: []
  },
  {
    type: 'error',
    name: 'TimelockNotDecreasing',
    inputs: []
  },
  {
    type: 'error',
    name: 'SharePriceAboveOne',
    inputs: []
  },
  {
    type: 'error',
    name: 'TimelockNotExpired',
    inputs: []
  },
  {
    type: 'error',
    name: 'TransferReturnedFalse',
    inputs: []
  },
  {
    type: 'error',
    name: 'TransferReverted',
    inputs: []
  }
] as const
