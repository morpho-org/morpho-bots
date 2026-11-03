import type { TxPayload } from '@repo/kernel'
import type { SwapPlan } from '@repo/swaps'
import type { Hex } from 'viem'

import { Executor, MidnightAbi } from '@repo/contracts'
import { skimCall } from '@repo/swaps'
import { executorLiquidationValidator } from '@repo/validators'
import { ExecutorEncoder } from 'executooor-viem'
import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  zeroAddress
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { Market } from '../../src/execution/encode-call'

import { encodeLiquidationExec } from '../../src/execution/encode-call'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MIDNIGHT = getAddress('0x2222222222222222222222222222222222222222')
const BORROWER = getAddress('0x3333333333333333333333333333333333333333')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const STRANGER = getAddress('0x8888888888888888888888888888888888888888')
const WRAPPED = getAddress('0x9999999999999999999999999999999999999999')

const market: Market = {
  chainId: 8453n,
  midnight: MIDNIGHT,
  loanToken: LOAN,
  collateralParams: [
    {
      token: COLLATERAL,
      lltv: 860000000000000000n,
      liquidationCursor: 250000000000000000n,
      oracle: STRANGER
    }
  ],
  maturity: 2000n,
  rcfThreshold: 1000000000000000000n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}

const swap: SwapPlan = {
  steps: [
    {
      tokenIn: COLLATERAL,
      tokenOut: WRAPPED,
      target: ROUTER,
      value: 0n,
      callData: `0x${'be'.repeat(196)}`,
      amountIn: { source: 'balance', offset: 132n },
      approvalSpender: ROUTER
    },
    {
      tokenIn: WRAPPED,
      tokenOut: LOAN,
      target: ROUTER,
      value: 0n,
      callData: `0x${'c0'.repeat(8)}`,
      amountIn: { source: 'fixed', value: 10n },
      approvalSpender: ROUTER
    }
  ],
  expectedAmountOut: 2000n,
  amountOutMinimum: 1900n
}

const exec = (overrides: Partial<Parameters<typeof encodeLiquidationExec>[0]> = {}): Hex =>
  encodeLiquidationExec({
    executor: EXECUTOR,
    midnight: MIDNIGHT,
    market,
    collateralIndex: 0,
    seizedAssets: 100n,
    repaidUnits: 0n,
    borrower: BORROWER,
    postMaturityMode: false,
    plan: swap,
    recipient: ACCOUNT,
    ...overrides
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
  protocol: { kind: 'midnight', midnight: MIDNIGHT }
})
const read = (payload: TxPayload, account: string = ACCOUNT) =>
  validator.read(payload, undefined, { account, chainId: 8453 })

/** The exec's calls, edited, re-encoded. */
const withCalls = (data: Hex, edit: (calls: Hex[]) => Hex[]): Hex => {
  const decoded = decodeFunctionData({ abi: Executor.abi, data })
  const calls = [...(decoded.args as readonly [readonly Hex[]])[0]]
  return encodeFunctionData({
    abi: Executor.abi,
    functionName: 'exec_606BaXt',
    args: [edit(calls)]
  })
}

const liquidateWith = (
  edit: (args: unknown[]) => unknown[],
  context = { sender: MIDNIGHT, dataIndex: 8n }
) =>
  withCalls(exec(), ([first, ...rest]) => {
    const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
    const inner = decodeFunctionData({
      abi: MidnightAbi,
      data: (outer.args as unknown[])[3] as Hex
    })
    const args = edit([...(inner.args as unknown as unknown[])])
    const callData = encodeFunctionData({
      abi: MidnightAbi,
      functionName: 'liquidate',
      args
    } as never)
    return [ExecutorEncoder.buildCall(MIDNIGHT, 0n, callData, context), ...rest]
  })

const CALLBACK = [{ type: 'bytes[]' }, { type: 'bytes' }] as const

/** The callback context word decoded back into what `buildCall` takes. */
const contextOf = (context: Hex) => ({
  sender: getAddress(`0x${context.slice(26)}`),
  dataIndex: BigInt(`0x${context.slice(2, 26)}`)
})

/** The exec with its callback queue and return value edited. */
const withCallback = (edit: (queue: Hex[], returns: Hex) => [Hex[], Hex]) =>
  liquidateWith(args => {
    const [queue, returns] = decodeAbiParameters(CALLBACK, args[8] as Hex)
    return [...args.slice(0, 8), encodeAbiParameters(CALLBACK, edit([...queue], returns))]
  })

const transferTo = (recipient: Hex) =>
  ExecutorEncoder.buildCall(
    LOAN,
    0n,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 1n] })
  )

/** A venue step whose amount is spliced in by one placeholder, edited. */
const stepWith = (
  placeholder: Partial<{ data: Hex; offset: bigint }>,
  callData: Hex = `0x${'be'.repeat(36)}`
) =>
  ExecutorEncoder.buildCall(ROUTER, 0n, callData, undefined, [
    {
      to: COLLATERAL,
      data:
        placeholder.data ??
        encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [EXECUTOR] }),
      offset: placeholder.offset ?? 4n,
      length: 32n,
      resOffset: 0n
    }
  ])

/** An ERC-4626 redeem of the Executor's whole share balance, as the unwrapper encodes it. */
const redeem = (receiver: Hex, owner: Hex, offset = 4n) =>
  ExecutorEncoder.buildCall(
    COLLATERAL,
    0n,
    encodeFunctionData({
      abi: parseAbi(['function redeem(uint256 shares, address receiver, address owner)']),
      functionName: 'redeem',
      args: [0n, receiver, owner]
    }),
    undefined,
    [
      {
        to: COLLATERAL,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [EXECUTOR] }),
        offset,
        length: 32n,
        resOffset: 0n
      }
    ]
  )

describe('vault exits in the callback queue', () => {
  it('accepts a redeem that burns and pays the Executor', () => {
    const data = withCallback((queue, returns) => [[redeem(EXECUTOR, EXECUTOR), ...queue], returns])
    expect(read(tx(data)).ok).toBe(true)
  })

  it.each([
    ['pays a stranger', redeem(STRANGER, EXECUTOR)],
    ['burns a stranger’s shares', redeem(EXECUTOR, STRANGER)]
  ])('refuses a redeem that %s', (_, step) => {
    const data = withCallback((queue, returns) => [[step, ...queue], returns])
    expect(read(tx(data))).toStrictEqual({
      ok: false,
      reason: 'a vault exit pays someone other than the Executor'
    })
  })
  it.each([36n, 68n])('refuses a redeem splicing word %i over its receiver or owner', offset => {
    const data = withCallback((queue, returns) => [
      [redeem(EXECUTOR, EXECUTOR, offset), ...queue],
      returns
    ])
    expect(read(tx(data))).toStrictEqual({
      ok: false,
      reason: 'a vault exit splices more than its amount'
    })
  })
})

describe('the callback queue', () => {
  it('accepts a step whose placeholder splices the Executor balance past its selector', () => {
    const data = withCallback((queue, returns) => [[stepWith({}), ...queue], returns])
    expect(read(tx(data)).ok).toBe(true)
  })

  it.each([
    [
      'a transfer out of the Executor',
      withCallback((queue, returns) => [[transferTo(STRANGER), ...queue], returns]),
      'the callback transfers a token'
    ],
    [
      'another return value',
      withCallback(queue => [queue, '0x']),
      'callback does not return the success value'
    ],
    [
      'a fixed approval',
      withCallback((queue, returns) => [
        [ExecutorEncoder.buildErc20Approve(COLLATERAL, STRANGER, 10n ** 18n), ...queue],
        returns
      ]),
      'an approval names a fixed amount'
    ],
    [
      'no repay approval at its end',
      withCallback((queue, returns) => [queue.slice(0, -2), returns]),
      'the callback does not end approving the protocol to pull the repay'
    ],
    [
      'a nested callback',
      withCallback((queue, returns) => [
        [
          ExecutorEncoder.buildCall(ROUTER, 0n, '0x', { sender: STRANGER, dataIndex: 0n }),
          ...queue
        ],
        returns
      ]),
      'a callback call carries value or a callback, or calls the Executor'
    ],
    [
      'a call to the Executor itself',
      withCallback((queue, returns) => [
        [ExecutorEncoder.buildCall(EXECUTOR, 0n, '0x'), ...queue],
        returns
      ]),
      'a callback call carries value or a callback, or calls the Executor'
    ],
    [
      'a step splicing over its selector',
      withCallback((queue, returns) => [[stepWith({ offset: 0n }), ...queue], returns]),
      'a step splices something other than an Executor balance word'
    ],
    [
      'a step splicing a read other than a balance',
      withCallback((queue, returns) => [
        [
          stepWith({
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' })
          }),
          ...queue
        ],
        returns
      ]),
      'a step splices something other than an Executor balance word'
    ],
    [
      'a step splicing across two words',
      withCallback((queue, returns) => [
        [stepWith({ offset: 5n }, `0x${'be'.repeat(68)}`), ...queue],
        returns
      ]),
      'a step splices something other than an Executor balance word'
    ],
    [
      'a step splicing past its calldata',
      withCallback((queue, returns) => [[stepWith({ offset: 36n }), ...queue], returns]),
      'a step splices something other than an Executor balance word'
    ],
    [
      'an approved intermediate left unswept',
      withCalls(exec(), calls => calls.slice(0, 3)),
      'the tokens it touches are not all swept to the account'
    ]
  ])('refuses %s', (_, data, reason) => {
    expect(read(tx(data))).toStrictEqual({ ok: false, reason })
  })
})

describe('executorLiquidationValidator on Midnight', () => {
  it('reads a swap liquidation that sweeps every market token to the account as no commitment', () => {
    expect(read(tx(exec()))).toStrictEqual({
      ok: true,
      creates: [],
      exposes: [],
      carries: [],
      retires: [],
      consumes: {}
    })
  })

  it('reads a write-off as no commitment', () => {
    expect(read(tx(exec({ seizedAssets: 0n, repaidUnits: 0n, plan: null }))).ok).toBe(true)
  })

  it('reads a loan-as-collateral liquidation, whose one swept token is both market tokens', () => {
    const loanAsCollateral: Market = {
      ...market,
      collateralParams: [{ ...market.collateralParams[0]!, token: LOAN }]
    }
    const data = exec({ market: loanAsCollateral, plan: { ...swap, steps: [] } })
    expect(read(tx(data)).ok).toBe(true)
  })

  it('claims only transactions to the Executor', () => {
    expect(validator.claims(tx(exec()))).toBe(true)
    expect(validator.claims(tx(exec(), { to: STRANGER }))).toBe(false)
    expect(
      validator.claims({ kind: 'typed', domain: {}, types: {}, primaryType: 'X', message: {} })
    ).toBe(false)
  })

  it.each([
    ['value', tx(exec(), { value: 1n }), 'an Executor call carries no value'],
    ['trailing bytes', tx(concatHex([exec(), '0x00'])), 'calldata is not canonical'],
    [
      'another selector',
      tx(encodeFunctionData({ abi: Executor.abi, functionName: 'transfer', args: [ACCOUNT, 1n] })),
      'not Executor.exec_606BaXt'
    ],
    ['no calls', tx(withCalls(exec(), () => [])), 'exec carries no call'],
    [
      'a missing loan sweep',
      tx(withCalls(exec(), calls => calls.filter((_, i) => i !== 1))),
      'the tokens it touches are not all swept to the account'
    ],
    [
      'a missing collateral sweep',
      tx(withCalls(exec(), calls => calls.filter((_, i) => i !== 2))),
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
    [
      'a sweep of a stranger balance',
      tx(
        withCalls(exec(), calls => [
          ...calls.slice(0, 1),
          skimCall(LOAN, ACCOUNT, STRANGER),
          ...calls.slice(2)
        ])
      ),
      'sweep amount is not the Executor balance of its token'
    ],
    [
      'a swept token twice',
      tx(withCalls(exec(), calls => [...calls, calls[1]!])),
      'a token is swept twice'
    ],
    [
      'a call before liquidate',
      tx(withCalls(exec(), calls => [calls[1]!, ...calls])),
      'first call is not a plain call to the protocol'
    ],
    [
      'a fixed transfer',
      tx(
        withCalls(exec(), calls => [
          ...calls,
          ExecutorEncoder.buildErc20Transfer(LOAN, STRANGER, 1n)
        ])
      ),
      'sweep does not pay the account'
    ],
    [
      'another Midnight',
      tx(liquidateWith(args => [{ ...(args[0] as Market), midnight: STRANGER }, ...args.slice(1)])),
      'market is not on this Midnight'
    ],
    [
      'a receiver other than the Executor',
      tx(liquidateWith(args => [...args.slice(0, 6), STRANGER, ...args.slice(7)])),
      'seized collateral is not received and called back on the Executor'
    ],
    [
      'a callback other than the Executor',
      tx(liquidateWith(args => [...args.slice(0, 7), STRANGER, ...args.slice(8)])),
      'seized collateral is not received and called back on the Executor'
    ],
    [
      'a callback context for a stranger',
      tx(liquidateWith(args => args, { sender: STRANGER, dataIndex: 8n })),
      'seized collateral is not received and called back on the Executor'
    ],
    [
      'an out of range collateral',
      tx(liquidateWith(args => [args[0], 5n, ...args.slice(2)])),
      'collateral index out of range'
    ],
    [
      'a write-off paying a stranger',
      tx(exec({ seizedAssets: 0n, repaidUnits: 0n, plan: null, recipient: STRANGER })),
      'a write-off moves nothing and calls nothing back'
    ],
    ['undecodable calldata', tx('0xdeadbeef'), 'calldata does not decode'],
    [
      'a first call carrying value',
      tx(
        withCalls(exec(), ([first, ...rest]) => {
          const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
          const [, , context, callData] = outer.args as readonly [Hex, bigint, Hex, Hex]
          return [ExecutorEncoder.buildCall(MIDNIGHT, 1n, callData, contextOf(context)), ...rest]
        })
      ),
      'first call is not a plain call to the protocol'
    ],
    [
      'a call other than liquidate',
      tx(
        withCalls(exec(), ([, ...rest]) => [
          ExecutorEncoder.buildCall(
            MIDNIGHT,
            0n,
            encodeFunctionData({ abi: MidnightAbi, functionName: 'touchMarket', args: [market] })
          ),
          ...rest
        ])
      ),
      'first call is not liquidate'
    ],
    [
      'a write-off that calls back',
      tx(
        withCalls(exec({ seizedAssets: 0n, repaidUnits: 0n, plan: null }), ([first]) => {
          const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
          const inner = decodeFunctionData({
            abi: MidnightAbi,
            data: (outer.args as unknown[])[3] as Hex
          })
          const args = [...(inner.args as unknown as unknown[])]
          args[7] = EXECUTOR
          const callData = encodeFunctionData({
            abi: MidnightAbi,
            functionName: 'liquidate',
            args
          } as never)
          return [ExecutorEncoder.buildCall(MIDNIGHT, 0n, callData)]
        })
      ),
      'a write-off moves nothing and calls nothing back'
    ],
    [
      'a callback context naming another data word',
      tx(liquidateWith(args => args, { sender: MIDNIGHT, dataIndex: 1n })),
      'seized collateral is not received and called back on the Executor'
    ],
    [
      'a write-off carrying a callback context',
      tx(
        withCalls(exec({ seizedAssets: 0n, repaidUnits: 0n, plan: null }), ([first]) => {
          const outer = decodeFunctionData({ abi: Executor.abi, data: first! })
          const callData = (outer.args as unknown[])[3] as Hex
          return [
            ExecutorEncoder.buildCall(MIDNIGHT, 0n, callData, { sender: MIDNIGHT, dataIndex: 8n })
          ]
        })
      ),
      'a write-off moves nothing and calls nothing back'
    ],
    [
      'a write-off followed by another call',
      tx(
        withCalls(exec({ seizedAssets: 0n, repaidUnits: 0n, plan: null }), calls => [
          ...calls,
          skimCall(LOAN, ACCOUNT, EXECUTOR)
        ])
      ),
      'a write-off moves nothing and calls nothing back'
    ],
    [
      'a sweep carrying value',
      tx(
        withCalls(exec(), calls => [
          ...calls,
          ExecutorEncoder.buildCall(
            WRAPPED,
            1n,
            encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ACCOUNT, 0n] })
          )
        ])
      ),
      'sweep carries value'
    ],
    [
      'a sweep that is not a transfer',
      tx(
        withCalls(exec(), calls => [
          ...calls,
          ExecutorEncoder.buildCall(
            WRAPPED,
            0n,
            encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACCOUNT, 0n] })
          )
        ])
      ),
      'sweep is not a transfer'
    ],
    [
      'a sweep whose amount is not spliced in',
      tx(
        withCalls(exec(), calls => [
          ...calls.slice(0, 1),
          ExecutorEncoder.buildCall(
            LOAN,
            0n,
            encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ACCOUNT, 0n] })
          ),
          ...calls.slice(2)
        ])
      ),
      'sweep amount is not one balance read'
    ],
    [
      'a call the Executor does not nest',
      tx(
        withCalls(exec(), calls => [
          ...calls,
          encodeFunctionData({ abi: Executor.abi, functionName: 'exec_606BaXt', args: [[]] })
        ])
      ),
      'unexpected inner call exec_606BaXt'
    ],
    [
      'callback data with trailing bytes',
      tx(liquidateWith(args => [...args.slice(0, 8), concatHex([args[8] as Hex, '0x00'])])),
      'callback data is not canonical'
    ],
    [
      'an approval of a stranger balance',
      tx(
        withCallback((queue, returns) => [
          [
            ExecutorEncoder.buildCall(
              WRAPPED,
              0n,
              encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 0n] }),
              undefined,
              [
                {
                  to: WRAPPED,
                  data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [STRANGER]
                  }),
                  offset: 36n,
                  length: 32n,
                  resOffset: 0n
                }
              ]
            ),
            ...queue
          ],
          returns
        ])
      ),
      'approval amount is not the Executor balance of its token'
    ]
  ])('refuses %s', (_, payload, reason) => {
    expect(read(payload)).toStrictEqual({ ok: false, reason })
  })

  it.each([
    ['a typed payload', { kind: 'typed', domain: {}, types: {}, primaryType: 'X', message: {} }],
    ['a transaction', tx(exec())]
  ] as const)('refuses %s read for an account that is not an address', (_, payload) => {
    expect(validator.read(payload, undefined, { account: 'nobody', chainId: 8453 })).toStrictEqual({
      ok: false,
      reason: payload.kind === 'tx' ? 'the account is not an address' : 'only transactions are read'
    })
  })

  it('refuses a liquidation read for another account', () => {
    expect(read(tx(exec()), STRANGER)).toStrictEqual({
      ok: false,
      reason: 'sweep does not pay the account'
    })
  })

  it('refuses a liquidation on another chain', () => {
    expect(validator.read(tx(exec()), undefined, { account: ACCOUNT, chainId: 1 })).toStrictEqual({
      ok: false,
      reason: 'market is not on this Midnight'
    })
  })

  it('never reads an approval', () => {
    const approve = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [STRANGER, 1n]
    })
    expect(
      read(tx(withCalls(exec(), calls => [...calls, ExecutorEncoder.buildCall(LOAN, 0n, approve)])))
        .ok
    ).toBe(false)
  })
})
