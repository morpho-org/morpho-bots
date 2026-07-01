import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, getAddress } from 'viem'

import type { MarketParams } from '../../src/market'
import type { Swap } from '../../src/quotes/types'

import { WAD } from '../../src/constants'
import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1234567890123456789012345678901234567890')
const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000ee01')
const BORROWER = getAddress('0x000000000000000000000000000000000000b011')
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481')

const MARKET: MarketParams = {
  loanToken: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
  oracle: getAddress('0x1111111111111111111111111111111111111111'),
  irm: getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687'),
  lltv: 86n * 10n ** 16n
}

// Minimal single-purpose ABIs so viem decodes to precise types (no union-narrowing casts needed).
const EXEC_ABI = [
  {
    type: 'function',
    name: 'exec_606BaXt',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: []
  }
] as const

// Matches executooor's `struct Placeholder` exactly (offset/length/resOffset are uint64) — the
// signature must be byte-identical or the callWithPlaceholders selector won't match for decoding.
const PLACEHOLDER_COMPONENTS = [
  { name: 'to', type: 'address' },
  { name: 'data', type: 'bytes' },
  { name: 'offset', type: 'uint64' },
  { name: 'length', type: 'uint64' },
  { name: 'resOffset', type: 'uint64' }
] as const

// The two Executor sub-call shapes buildCall emits; both share (target, value, context, callData) as
// their first four inputs, so args[0]/args[3] decode to a plain hex string on the union.
const SUBCALL_ABI = [
  {
    type: 'function',
    name: 'call_g0oyU7o',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'context', type: 'bytes32' },
      { name: 'callData', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'callWithPlaceholders4845164670',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'context', type: 'bytes32' },
      { name: 'callData', type: 'bytes' },
      { name: 'placeholders', type: 'tuple[]', components: PLACEHOLDER_COMPONENTS }
    ],
    outputs: []
  }
] as const

// Minimal ERC20 subset (approve + transfer) so args[0] decodes to a plain address — the full
// viem erc20Abi has argless functions, which would union args[0] with undefined.
const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  }
] as const

const LIQUIDATE_ABI = [
  {
    type: 'function',
    name: 'liquidate',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'irm', type: 'address' },
          { name: 'lltv', type: 'uint256' }
        ]
      },
      { name: 'borrower', type: 'address' },
      { name: 'seizedAssets', type: 'uint256' },
      { name: 'repaidShares', type: 'uint256' },
      { name: 'data', type: 'bytes' }
    ],
    outputs: []
  }
] as const

const balanceSwap: Swap = {
  spender: ROUTER,
  target: ROUTER,
  value: 0n,
  callData: '0xdeadbeef',
  amountIn: { source: 'balance', offset: 132n },
  expectedAmountOut: 999n * WAD,
  amountOutMinimum: 990n * WAD
}

const fixedSwap: Swap = {
  spender: getAddress('0x0000000000001fF3684f28c67538d4D072C22734'),
  target: getAddress('0xAbCdeF0000000000000000000000000000000000'),
  value: 0n,
  callData: '0xcafebabe',
  amountIn: { source: 'fixed', value: 5n * WAD },
  expectedAmountOut: 999n * WAD,
  amountOutMinimum: 990n * WAD
}

function encode(swap: Swap): Hex {
  return encodeLiquidationExec({
    executor: EXECUTOR,
    morpho: MORPHO,
    market: MARKET,
    seizedAssets: 3n * WAD,
    borrower: BORROWER,
    swap,
    recipient: RECIPIENT
  })
}

/** The three top-level Executor sub-calls of an exec_606BaXt. */
function execCalls(data: Hex): readonly Hex[] {
  const [calls] = decodeFunctionData({ abi: EXEC_ABI, data }).args
  return calls
}

/** A sub-call's { functionName, target, callData }. */
function decodeSubCall(blob: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: SUBCALL_ABI, data: blob })
  return { functionName, target: getAddress(args[0]), callData: args[3] }
}

/** The [callbackQueue, returnData] a liquidate call rides on. */
function decodeCallback(liquidateCall: Hex): { queue: readonly Hex[]; returnData: Hex } {
  const { args } = decodeFunctionData({
    abi: LIQUIDATE_ABI,
    data: decodeSubCall(liquidateCall).callData
  })
  const [queue, returnData] = decodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes' }], args[4])
  return { queue, returnData }
}

describe('encodeLiquidationExec', () => {
  it('emits exec_606BaXt with exactly [liquidate, skim(loan), skim(collateral)]', () => {
    const { functionName } = decodeFunctionData({ abi: EXEC_ABI, data: encode(balanceSwap) })
    expect(functionName).toBe('exec_606BaXt')
    const calls = execCalls(encode(balanceSwap))
    expect(calls).toHaveLength(3)

    // Sub-call 0: the liquidate to Morpho.
    expect(decodeSubCall(calls[0]!).target).toBe(MORPHO)
    // Sub-calls 1 & 2: the dual-token full-drain sweeps to the EOA (loan then collateral).
    expect(decodeSubCall(calls[1]!).target).toBe(MARKET.loanToken)
    expect(decodeSubCall(calls[2]!).target).toBe(MARKET.collateralToken)
  })

  it('encodes Morpho.liquidate with the pinned seize and repaidShares = 0 (seize-exact)', () => {
    const calls = execCalls(encode(balanceSwap))
    const { args } = decodeFunctionData({
      abi: LIQUIDATE_ABI,
      data: decodeSubCall(calls[0]!).callData
    })
    const [market, borrower, seizedAssets, repaidShares] = args
    expect(getAddress(market.collateralToken)).toBe(MARKET.collateralToken)
    expect(getAddress(market.loanToken)).toBe(MARKET.loanToken)
    expect(market.lltv).toBe(MARKET.lltv)
    expect(getAddress(borrower)).toBe(BORROWER)
    expect(seizedAssets).toBe(3n * WAD)
    expect(repaidShares).toBe(0n) // seize-exact: contract ceil-derives repaidShares
  })

  it('rides the callback queue in liquidate.data with empty return-data (Blue ignores the callback return)', () => {
    const calls = execCalls(encode(balanceSwap))
    const { queue, returnData } = decodeCallback(calls[0]!)
    // 5-call queue: approve(coll,0), approve(coll,bal), swap, approve(loan,0), approve(loan,bal).
    expect(queue).toHaveLength(5)
    expect(returnData).toBe('0x') // no magic-value trick — Morpho ignores onMorphoLiquidate's return
    // The swap call sits at queue index 2, targeting the venue.
    expect(decodeSubCall(queue[2]!).target).toBe(ROUTER)
    // The repay-approval targets Morpho (loan token approve to the singleton).
    const loanApprove = decodeFunctionData({
      abi: ERC20_MIN_ABI,
      data: decodeSubCall(queue[4]!).callData
    })
    expect(loanApprove.functionName).toBe('approve')
    expect(getAddress(loanApprove.args[0])).toBe(MORPHO)
  })

  it('splices the live balance for a Uniswap (balance) swap but not an aggregator (fixed) swap', () => {
    const balanceQueue = decodeCallback(execCalls(encode(balanceSwap))[0]!).queue
    // balance swap → callWithPlaceholders (spliced), fixed swap → plain call.
    expect(decodeSubCall(balanceQueue[2]!).functionName).toBe('callWithPlaceholders4845164670')

    const fixedQueue = decodeCallback(execCalls(encode(fixedSwap))[0]!).queue
    expect(decodeSubCall(fixedQueue[2]!).functionName).toBe('call_g0oyU7o')
  })

  it('sweeps transfer the full balance to the recipient EOA', () => {
    const calls = execCalls(encode(balanceSwap))
    const skimLoan = decodeFunctionData({
      abi: ERC20_MIN_ABI,
      data: decodeSubCall(calls[1]!).callData
    })
    expect(skimLoan.functionName).toBe('transfer')
    expect(getAddress(skimLoan.args[0])).toBe(RECIPIENT)
  })
})
