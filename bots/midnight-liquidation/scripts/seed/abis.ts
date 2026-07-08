// Minimal ABIs shared by the two position-seeding paths: the live operator script
// (scripts/seed-liquidatable-positions.ts) and the in-fork test seeder (test/fork/seed.ts). Both drive
// the same WETH-wrap → oracle-read → Uniswap-swap steps, so the ABIs live here to avoid divergence.

export const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }
] as const

export const ORACLE_ABI = [
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
] as const

// Uniswap `SwapRouter02` exactInputSingle (no `deadline`); same shape the bot's swap encoder uses.
export const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' }
        ]
      }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const
