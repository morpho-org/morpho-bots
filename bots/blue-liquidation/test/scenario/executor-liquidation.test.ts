import type { TxPayload } from '@repo/kernel'
import type { SwapPlan } from '@repo/swaps'
import type { Hex } from 'viem'

import { Executor, MorphoAbi } from '@repo/contracts'
import { skimCall } from '@repo/swaps'
import { executorLiquidationValidator } from '@repo/validators'
import { ExecutorEncoder } from 'executooor-viem'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../../src/market'

import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MORPHO = getAddress('0x2222222222222222222222222222222222222222')
const BORROWER = getAddress('0x3333333333333333333333333333333333333333')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const STRANGER = getAddress('0x8888888888888888888888888888888888888888')

const market: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: STRANGER,
  irm: STRANGER,
  lltv: 86n * 10n ** 16n
}

const swap: SwapPlan = {
  steps: [
    {
      tokenIn: COLLATERAL,
      tokenOut: LOAN,
      target: ROUTER,
      value: 0n,
      callData: `0x${'be'.repeat(196)}`,
      amountIn: { source: 'balance', offset: 132n },
      approvalSpender: ROUTER
    }
  ],
  expectedAmountOut: 2000n,
  amountOutMinimum: 1900n
}

const exec = (plan: SwapPlan = swap): Hex =>
  encodeLiquidationExec({
    executor: EXECUTOR,
    morpho: MORPHO,
    market,
    seizedAssets: 100n,
    borrower: BORROWER,
    plan,
    recipient: ACCOUNT
  })

const tx = (data: Hex, overrides: Partial<TxPayload> = {}): TxPayload => ({
  kind: 'tx',
  to: EXECUTOR,
  data,
  value: 0n,
  ...overrides
})

const validator = executorLiquidationValidator({
  executor: EXECUTOR,
  protocol: { kind: 'blue', morpho: MORPHO }
})
const read = (payload: TxPayload) =>
  validator.read(payload, undefined, { account: ACCOUNT, chainId: 8453 })

const withCalls = (data: Hex, edit: (calls: Hex[]) => Hex[]): Hex => {
  const decoded = decodeFunctionData({ abi: Executor.abi, data })
  const calls = [...(decoded.args as readonly [readonly Hex[]])[0]]
  return encodeFunctionData({
    abi: Executor.abi,
    functionName: 'exec_606BaXt',
    args: [edit(calls)]
  })
}

const CALLBACK = [{ type: 'bytes[]' }, { type: 'bytes' }] as const

/** The exec with its liquidate arguments or callback context edited. */
const liquidateWith = (
  edit: (args: unknown[]) => unknown[],
  context = { sender: MORPHO, dataIndex: 1n }
) =>
  withCalls(exec(), ([first, ...rest]) => {
    const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
    const inner = decodeFunctionData({
      abi: MorphoAbi,
      data: (outer.args as unknown[])[3] as Hex
    })
    const args = edit([...(inner.args as unknown as unknown[])])
    const callData = encodeFunctionData({
      abi: MorphoAbi,
      functionName: 'liquidate',
      args
    } as never)
    return [ExecutorEncoder.buildCall(MORPHO, 0n, callData, context), ...rest]
  })

const withCallback = (edit: (queue: Hex[], returns: Hex) => [Hex[], Hex]) =>
  liquidateWith(args => {
    const [queue, returns] = decodeAbiParameters(CALLBACK, args[4] as Hex)
    return [...args.slice(0, 4), encodeAbiParameters(CALLBACK, edit([...queue], returns))]
  })

describe('executorLiquidationValidator on Blue', () => {
  it('reads the bot’s own liquidation as no commitment', () => {
    expect(read(tx(exec()))).toStrictEqual({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {}
    })
  })

  it.each([
    ['pays the Executor', EXECUTOR],
    ['pays a stranger', STRANGER]
  ])('reads an ERC-4626 unwrap step that %s', (_, receiver) => {
    const unwrap: SwapPlan = {
      ...swap,
      steps: [
        {
          tokenIn: COLLATERAL,
          tokenOut: LOAN,
          target: COLLATERAL,
          value: 0n,
          callData: encodeFunctionData({
            abi: parseAbi(['function redeem(uint256 shares, address receiver, address owner)']),
            functionName: 'redeem',
            args: [0n, receiver, EXECUTOR]
          }),
          amountIn: { source: 'balance', offset: 4n }
        }
      ]
    }
    expect(read(tx(exec(unwrap)))).toStrictEqual(
      receiver === EXECUTOR
        ? expect.objectContaining({ ok: true })
        : { ok: false, reason: 'a vault exit pays someone other than the Executor' }
    )
  })

  it('reads a liquidation whose unwrap already ends in the loan token', () => {
    expect(read(tx(exec({ ...swap, steps: [] }))).ok).toBe(true)
  })

  it.each([
    [
      'a call to another singleton',
      tx(
        withCalls(exec(), ([first, ...rest]) => {
          const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
          const callData = (outer.args as unknown[])[3] as Hex
          return [
            ExecutorEncoder.buildCall(STRANGER, 0n, callData, {
              sender: MORPHO,
              dataIndex: 1n
            }),
            ...rest
          ]
        })
      ),
      'first call is not a plain call to the protocol'
    ],
    [
      'a callback context for a stranger',
      tx(liquidateWith(args => args, { sender: STRANGER, dataIndex: 1n })),
      'seized collateral is not received and called back on the Executor'
    ],
    [
      'a callback that returns data',
      tx(withCallback(queue => [queue, '0x01'])),
      'callback does not return the success value'
    ],
    [
      'a callback transfer out',
      tx(
        withCallback((queue, returns) => [
          [
            ExecutorEncoder.buildCall(
              LOAN,
              0n,
              encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [STRANGER, 1n] })
            ),
            ...queue
          ],
          returns
        ])
      ),
      'the callback transfers a token'
    ],
    [
      'no repay approval for Morpho',
      tx(withCallback((queue, returns) => [queue.slice(0, -2), returns])),
      'the callback does not end approving the protocol to pull the repay'
    ],
    [
      'a missing collateral sweep',
      tx(withCalls(exec(), calls => calls.filter((_, index) => index !== 2))),
      'the tokens it touches are not all swept to the account'
    ],
    [
      'a sweep to a stranger',
      tx(
        withCalls(exec(), calls => [
          ...calls.slice(0, 1),
          skimCall(LOAN, STRANGER, EXECUTOR),
          ...calls.slice(2)
        ])
      ),
      'sweep does not pay the account'
    ],
    ['value', tx(exec(), { value: 1n }), 'an Executor call carries no value']
  ])('refuses %s', (_, payload, reason) => {
    expect(read(payload)).toStrictEqual({ ok: false, reason })
  })
})
