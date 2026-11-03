import type { Payload, TxPayload } from '@repo/kernel'
import type { Hex } from 'viem'

import { Executor, MidnightAbi, MorphoAbi } from '@repo/contracts'
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { LiquidationProtocol } from '../src/executor-liquidation'

import { executorLiquidationValidator } from '../src'
import { itReadsAsRecorded } from './recorded-readings'

const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const PROTOCOL = getAddress('0x2222222222222222222222222222222222222222')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')

const tx = (data: Hex, overrides: Partial<TxPayload> = {}): TxPayload => ({
  kind: 'tx',
  to: EXECUTOR,
  data,
  value: 0n,
  ...overrides
})

const emptyExec = encodeFunctionData({
  abi: Executor.abi,
  functionName: 'exec_606BaXt',
  args: [[]]
})

const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const BORROWER = getAddress('0x3333333333333333333333333333333333333333')
const INTERMEDIATE = getAddress('0x8888888888888888888888888888888888888888')
const ROUTER = getAddress('0x9999999999999999999999999999999999999999')

const balanceOf = (token: Hex) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [EXECUTOR] }),
  offset: 36n,
  length: 32n,
  resOffset: 0n
})
const call = (target: Hex, callData: Hex, context: Hex = zeroHash) =>
  encodeFunctionData({
    abi: Executor.abi,
    functionName: 'call_g0oyU7o',
    args: [target, 0n, context, callData]
  })
const ofBalance = (token: Hex, callData: Hex) =>
  encodeFunctionData({
    abi: Executor.abi,
    functionName: 'callWithPlaceholders4845164670',
    args: [token, 0n, zeroHash, callData, [balanceOf(token)]]
  })
const sweep = (token: Hex, to: Hex = ACCOUNT) =>
  ofBalance(token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, 0n] }))
const transferOf = (amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ACCOUNT, amount] })
const sweepReading = (read: Partial<ReturnType<typeof balanceOf>>) =>
  encodeFunctionData({
    abi: Executor.abi,
    functionName: 'callWithPlaceholders4845164670',
    args: [LOAN, 0n, zeroHash, transferOf(0n), [{ ...balanceOf(LOAN), ...read }]]
  })
const approveIntermediate = ofBalance(
  INTERMEDIATE,
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 0n] })
)
const approveRepay = (spender: Hex) =>
  ofBalance(
    LOAN,
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] })
  )
const callback = (queue: readonly Hex[], returns: Hex) =>
  encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes' }], [queue, returns])
const callbackContext = (sender: Hex, dataIndex: number) =>
  `0x${dataIndex.toString(16).padStart(24, '0')}${sender.slice(2).toLowerCase()}` as Hex
const exec = (calls: readonly Hex[]) =>
  encodeFunctionData({ abi: Executor.abi, functionName: 'exec_606BaXt', args: [calls] })

const blueLiquidation = (
  queue: readonly Hex[] = [approveRepay(PROTOCOL)],
  context = callbackContext(PROTOCOL, 1)
) =>
  call(
    PROTOCOL,
    encodeFunctionData({
      abi: MorphoAbi,
      functionName: 'liquidate',
      args: [
        {
          loanToken: LOAN,
          collateralToken: COLLATERAL,
          oracle: zeroAddress,
          irm: zeroAddress,
          lltv: 0n
        },
        BORROWER,
        5n,
        0n,
        callback(queue, '0x')
      ]
    }),
    context
  )

const MIDNIGHT_MARKET = {
  chainId: 8453n,
  midnight: PROTOCOL,
  loanToken: LOAN,
  collateralParams: [
    {
      token: COLLATERAL,
      lltv: 860_000_000_000_000_000n,
      liquidationCursor: 0n,
      oracle: zeroAddress
    }
  ],
  maturity: 2_000n,
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const midnightLiquidation = (
  seized: bigint,
  receiver: Hex,
  callbackTo: Hex,
  data: Hex,
  context: Hex
) =>
  call(
    PROTOCOL,
    encodeFunctionData({
      abi: MidnightAbi,
      functionName: 'liquidate',
      args: [MIDNIGHT_MARKET, 0n, seized, 0n, BORROWER, false, receiver, callbackTo, data]
    }),
    context
  )
const MIDNIGHT_SUCCESS = keccak256(stringToHex('morpho.midnight.callbackSuccess'))
const midnightSeizure = (queue: readonly Hex[] = [approveRepay(PROTOCOL)]) =>
  midnightLiquidation(
    5n,
    EXECUTOR,
    EXECUTOR,
    callback(queue, MIDNIGHT_SUCCESS),
    callbackContext(PROTOCOL, 8)
  )

describe('executorLiquidationValidator readings', () => {
  const at = (payload: Payload, account: string = ACCOUNT) => ({
    payload,
    context: { account, chainId: 8453 }
  })
  const sweeps = [sweep(LOAN), sweep(COLLATERAL)]

  itReadsAsRecorded(
    new URL('readings/executor-liquidation-blue.json', import.meta.url),
    executorLiquidationValidator({
      executor: EXECUTOR,
      protocol: { kind: 'blue', morpho: PROTOCOL }
    }),
    () => ({
      'a liquidation sweeping both tokens': at(tx(exec([blueLiquidation(), ...sweeps]))),
      'a liquidation leaving collateral unswept': at(tx(exec([blueLiquidation(), sweep(LOAN)]))),
      'a sweep to someone else': at(
        tx(exec([blueLiquidation(), sweep(LOAN), sweep(COLLATERAL, BORROWER)]))
      ),
      'a token swept twice': at(tx(exec([blueLiquidation(), ...sweeps, sweep(LOAN)]))),
      'a sweep of a fixed amount': at(
        tx(exec([blueLiquidation(), call(LOAN, transferOf(1n)), sweep(COLLATERAL)]))
      ),
      'a sweep without the balance read': at(
        tx(exec([blueLiquidation(), call(LOAN, transferOf(0n)), sweep(COLLATERAL)]))
      ),
      'an approved intermediate left unswept': at(
        tx(exec([blueLiquidation([approveIntermediate, approveRepay(PROTOCOL)]), ...sweeps]))
      ),
      'a sweep reading the balance of another holder': at(
        tx(
          exec([
            blueLiquidation(),
            sweepReading({
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [ACCOUNT]
              })
            }),
            sweep(COLLATERAL)
          ])
        )
      ),
      'a sweep reading the balance of another token': at(
        tx(exec([blueLiquidation(), sweepReading({ to: COLLATERAL }), sweep(COLLATERAL)]))
      ),
      'a sweep splicing its balance elsewhere': at(
        tx(exec([blueLiquidation(), sweepReading({ offset: 4n }), sweep(COLLATERAL)]))
      ),
      'a callback step that calls the Executor': at(
        tx(exec([blueLiquidation([call(EXECUTOR, '0x1234'), approveRepay(PROTOCOL)]), ...sweeps]))
      ),
      'an approved intermediate swept too': at(
        tx(
          exec([
            blueLiquidation([approveIntermediate, approveRepay(PROTOCOL)]),
            ...sweeps,
            sweep(INTERMEDIATE)
          ])
        )
      ),
      'a callback that transfers out': at(
        tx(exec([blueLiquidation([sweep(LOAN), approveRepay(PROTOCOL)]), ...sweeps]))
      ),
      'a callback that does not end approving the repay': at(
        tx(exec([blueLiquidation([approveRepay(PROTOCOL), call(BORROWER, '0x1234')]), ...sweeps]))
      ),
      'a callback that approves the wrong spender': at(
        tx(exec([blueLiquidation([approveRepay(BORROWER)]), ...sweeps]))
      ),
      'a callback that approves a fixed amount': at(
        tx(
          exec([
            blueLiquidation([
              ofBalance(
                LOAN,
                encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [PROTOCOL, 1n]
                })
              )
            ]),
            ...sweeps
          ])
        )
      ),
      'a liquidation called back elsewhere': at(
        tx(exec([blueLiquidation(undefined, callbackContext(EXECUTOR, 1)), ...sweeps]))
      ),
      'a first call to another target': at(tx(exec([call(BORROWER, '0x'), ...sweeps]))),
      'value attached': at(tx(exec([blueLiquidation(), ...sweeps]), { value: 1n })),
      'an exec that carries no call': at(tx(emptyExec)),
      'a release': at({ kind: 'release', channel: 'api', message: {} }),
      'a transaction to the protocol': at(
        tx(exec([blueLiquidation(), ...sweeps]), { to: PROTOCOL })
      )
    })
  )

  itReadsAsRecorded(
    new URL('readings/executor-liquidation-midnight.json', import.meta.url),
    executorLiquidationValidator({
      executor: EXECUTOR,
      protocol: { kind: 'midnight', midnight: PROTOCOL }
    }),
    () => ({
      'a liquidation sweeping both tokens': at(tx(exec([midnightSeizure(), ...sweeps]))),
      'a liquidation leaving collateral unswept': at(tx(exec([midnightSeizure(), sweep(LOAN)]))),
      'a sweep of a fixed amount': at(
        tx(exec([midnightSeizure(), call(LOAN, transferOf(1n)), sweep(COLLATERAL)]))
      ),
      'a sweep without the balance read': at(
        tx(exec([midnightSeizure(), call(LOAN, transferOf(0n)), sweep(COLLATERAL)]))
      ),
      'an approved intermediate left unswept': at(
        tx(exec([midnightSeizure([approveIntermediate, approveRepay(PROTOCOL)]), ...sweeps]))
      ),
      'a sweep reading the balance of another holder': at(
        tx(
          exec([
            midnightSeizure(),
            sweepReading({
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [ACCOUNT]
              })
            }),
            sweep(COLLATERAL)
          ])
        )
      ),
      'a sweep reading the balance of another token': at(
        tx(exec([midnightSeizure(), sweepReading({ to: COLLATERAL }), sweep(COLLATERAL)]))
      ),
      'a sweep splicing its balance elsewhere': at(
        tx(exec([midnightSeizure(), sweepReading({ offset: 4n }), sweep(COLLATERAL)]))
      ),
      'a callback step that calls the Executor': at(
        tx(exec([midnightSeizure([call(EXECUTOR, '0x1234'), approveRepay(PROTOCOL)]), ...sweeps]))
      ),
      'an approved intermediate swept too': at(
        tx(
          exec([
            midnightSeizure([approveIntermediate, approveRepay(PROTOCOL)]),
            ...sweeps,
            sweep(INTERMEDIATE)
          ])
        )
      ),
      'a write-off': at(tx(exec([midnightLiquidation(0n, ACCOUNT, zeroAddress, '0x', zeroHash)]))),
      'a write-off paying someone else': at(
        tx(exec([midnightLiquidation(0n, BORROWER, zeroAddress, '0x', zeroHash)]))
      ),
      'a write-off with a sweep': at(
        tx(exec([midnightLiquidation(0n, ACCOUNT, zeroAddress, '0x', zeroHash), sweep(LOAN)]))
      ),
      'a seizure received elsewhere': at(
        tx(
          exec([
            midnightLiquidation(
              5n,
              BORROWER,
              EXECUTOR,
              callback([approveRepay(PROTOCOL)], MIDNIGHT_SUCCESS),
              callbackContext(PROTOCOL, 8)
            ),
            ...sweeps
          ])
        )
      ),
      'a seizure called back elsewhere': at(
        tx(
          exec([
            midnightLiquidation(
              5n,
              EXECUTOR,
              BORROWER,
              callback([approveRepay(PROTOCOL)], MIDNIGHT_SUCCESS),
              callbackContext(PROTOCOL, 8)
            ),
            ...sweeps
          ])
        )
      ),
      'a callback returning the wrong value': at(
        tx(
          exec([
            midnightLiquidation(
              5n,
              EXECUTOR,
              EXECUTOR,
              callback([approveRepay(PROTOCOL)], '0x'),
              callbackContext(PROTOCOL, 8)
            ),
            ...sweeps
          ])
        )
      ),
      'a market on another chain': at(
        tx(
          exec([
            call(
              PROTOCOL,
              encodeFunctionData({
                abi: MidnightAbi,
                functionName: 'liquidate',
                args: [
                  { ...MIDNIGHT_MARKET, chainId: 1n },
                  0n,
                  0n,
                  0n,
                  BORROWER,
                  false,
                  ACCOUNT,
                  zeroAddress,
                  '0x'
                ]
              })
            )
          ])
        )
      ),
      'an account that is not an address': at(tx(exec([midnightSeizure(), ...sweeps])), '0xBot'),
      'a transaction to the protocol': at(
        tx(exec([midnightSeizure(), ...sweeps]), { to: PROTOCOL })
      )
    })
  )
})

describe.each<LiquidationProtocol>([
  { kind: 'blue', morpho: PROTOCOL },
  { kind: 'midnight', midnight: PROTOCOL }
])('executorLiquidationValidator on $kind', protocol => {
  const validator = executorLiquidationValidator({ executor: EXECUTOR, protocol })
  const read = (payload: Payload, account: string = ACCOUNT) =>
    validator.read(payload, undefined, { account, chainId: 8453 })

  it('claims only transactions to the Executor, in any address case', () => {
    expect(validator.claims(tx('0x', { to: EXECUTOR.toLowerCase() }))).toBe(true)
    expect(validator.claims(tx('0x', { to: PROTOCOL }))).toBe(false)
    expect(validator.claims(tx('0x', { to: 'not-an-address' }))).toBe(false)
    expect(
      validator.claims({ kind: 'release', channel: 'api', message: {} } as unknown as Payload)
    ).toBe(false)
  })

  it.each([
    [
      'a payload that is not a transaction',
      { kind: 'release', channel: 'api', message: {} },
      ACCOUNT,
      'only transactions are read'
    ],
    ['value attached', tx(emptyExec, { value: 1n }), ACCOUNT, 'an Executor call carries no value'],
    ['an account that is not an address', tx(emptyExec), '0xBot', 'the account is not an address'],
    [
      'a call other than exec',
      tx(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACCOUNT, 1n] })),
      ACCOUNT,
      'calldata does not decode'
    ],
    ['an exec that carries no call', tx(emptyExec), ACCOUNT, 'exec carries no call'],
    ['calldata that is not hex', tx('0xzz' as Hex), ACCOUNT, 'calldata does not decode'],
    ['an exec with trailing bytes', tx(`${emptyExec}00`), ACCOUNT, 'calldata is not canonical']
  ])('refuses %s', (_, payload, account, reason) => {
    expect(read(payload as Payload, account)).toStrictEqual({ ok: false, reason })
  })

  it('treats every receipt as confirming, since a liquidation promises no commitment', () => {
    expect(validator.confirm(tx(emptyExec), [])).toBe(true)
  })
})
