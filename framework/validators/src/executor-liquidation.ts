import type { ValidatorReading, Validator } from '@repo/kernel'
import type {
  Abi,
  Address,
  DecodeFunctionDataParameters,
  DecodeFunctionDataReturnType,
  EncodeFunctionDataParameters,
  Hex
} from 'viem'

import { Executor, MidnightAbi, MorphoAbi } from '@repo/contracts'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  size,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash
} from 'viem'

import { UnreadableCallError as Unreadable } from './errors'

/** The protocol a liquidation calls, at its address on this chain. */
export type LiquidationProtocol =
  | Readonly<{ kind: 'blue'; morpho: Address }>
  | Readonly<{ kind: 'midnight'; midnight: Address }>

const NOTHING: ValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}

const refuse = (reason: string): ValidatorReading => ({ ok: false, reason })

/** `transfer(recipient, amount)`: the amount word follows the selector and the address word. */
const TRANSFER_AMOUNT_OFFSET = 36n
const WORD_BYTES = 32n
const SELECTOR_BYTES = 4n
/** Blue's `onMorphoLiquidate(repaidAssets, data)` carries it in its second (head word 1). */
const BLUE_CALLBACK_DATA_INDEX = 1n
/**
 * Midnight's `onLiquidate(caller, id, market, collateralIndex, seizedAssets, repaidUnits, borrower,
 * receiver, data, badDebt)` carries it in its ninth (head word 8).
 */
const MIDNIGHT_CALLBACK_DATA_INDEX = 8n
/** What a Midnight callback must return, or the liquidation reverts: Midnight's `CALLBACK_SUCCESS`. */
const MIDNIGHT_CALLBACK_SUCCESS = keccak256(stringToHex('morpho.midnight.callbackSuccess'))
/** The Executor's fallback decodes a callback's data as `(bytes[] queue, bytes returnData)`. */
const CALLBACK_ABI = [{ type: 'bytes[]' }, { type: 'bytes' }] as const
const TRANSFER = toFunctionSelector('transfer(address,uint256)')
const TRANSFER_FROM = toFunctionSelector('transferFrom(address,address,uint256)')
const APPROVE = toFunctionSelector('approve(address,uint256)')
const VAULT_EXIT_ABI = parseAbi([
  'function redeem(uint256 shares, address receiver, address owner)',
  'function withdraw(uint256 assets, address receiver, address owner)'
])
const VAULT_EXITS = new Set<string>(VAULT_EXIT_ABI.map(item => toFunctionSelector(item)))

/** Decodes `data` with `abi` and requires it to re-encode byte for byte, so no bytes ride along. */
const decodeExact = <const abi extends Abi>(
  abi: abi,
  data: Hex
): DecodeFunctionDataReturnType<abi> => {
  const decoded = decodeFunctionData({ abi, data } as DecodeFunctionDataParameters<abi>)
  const encoded = encodeFunctionData({
    abi,
    functionName: decoded.functionName,
    args: decoded.args
  } as unknown as EncodeFunctionDataParameters)
  if (encoded.toLowerCase() !== data.toLowerCase())
    throw new Unreadable('calldata is not canonical')
  return decoded
}

/** The Executor's callback context: the address allowed to call back, and where its data sits. */
const contextOf = (sender: Address, dataIndex: bigint): Hex =>
  `0x${dataIndex.toString(16).padStart(24, '0')}${sender.slice(2).toLowerCase()}`

type InnerCall = Readonly<{
  target: Address
  value: bigint
  context: Hex
  callData: Hex
  placeholders: readonly Readonly<{
    to: Address
    data: Hex
    offset: bigint
    length: bigint
    resOffset: bigint
  }>[]
}>

const innerCall = (data: Hex): InnerCall => {
  const { functionName, args } = decodeExact(Executor.abi, data)
  if (functionName === 'call_g0oyU7o') {
    const [target, value, context, callData] = args as readonly [Address, bigint, Hex, Hex]
    return { target, value, context, callData, placeholders: [] }
  }
  if (functionName === 'callWithPlaceholders4845164670') {
    const [target, value, context, callData, placeholders] = args as readonly [
      Address,
      bigint,
      Hex,
      Hex,
      InnerCall['placeholders']
    ]
    return { target, value, context, callData, placeholders }
  }
  throw new Unreadable(`unexpected inner call ${functionName}`)
}

/**
 * A step's placeholders may only splice the Executor's balance of some token over one whole,
 * word-aligned word past the selector, so what runs keeps the selector the queue was read with.
 */
const checkStepPlaceholders = (call: InnerCall, executor: Address) => {
  const bytes = BigInt(size(call.callData))
  for (const placeholder of call.placeholders) {
    const read = decodeExact(erc20Abi, placeholder.data)
    if (
      read.functionName !== 'balanceOf' ||
      !isAddressEqual(read.args[0], executor) ||
      placeholder.length !== WORD_BYTES ||
      placeholder.resOffset !== 0n ||
      placeholder.offset < SELECTOR_BYTES ||
      (placeholder.offset - SELECTOR_BYTES) % WORD_BYTES !== 0n ||
      placeholder.offset + WORD_BYTES > bytes
    )
      throw new Unreadable('a step splices something other than an Executor balance word')
  }
}

/** An ERC-4626 exit burns the Executor's own shares and pays the Executor; only its amount is spliced. */
const checkVaultExit = (call: InnerCall, executor: Address) => {
  const [, receiver, owner] = decodeExact(VAULT_EXIT_ABI, call.callData).args
  if (!isAddressEqual(receiver, executor) || !isAddressEqual(owner, executor))
    throw new Unreadable('a vault exit pays someone other than the Executor')
  if (call.placeholders.some(placeholder => placeholder.offset !== SELECTOR_BYTES))
    throw new Unreadable('a vault exit splices more than its amount')
}

/** Requires an amount spliced in from one read of the Executor's own balance of the call's token. */
const checkBalanceRead = (call: InnerCall, executor: Address, what: string) => {
  const [balance, ...extra] = call.placeholders
  if (!balance || extra.length > 0) throw new Unreadable(`${what} amount is not one balance read`)
  const read = decodeExact(erc20Abi, balance.data)
  if (
    read.functionName !== 'balanceOf' ||
    !isAddressEqual(read.args[0], executor) ||
    !isAddressEqual(balance.to, call.target) ||
    balance.offset !== TRANSFER_AMOUNT_OFFSET ||
    balance.length !== WORD_BYTES ||
    balance.resOffset !== 0n
  )
    throw new Unreadable(`${what} amount is not the Executor balance of its token`)
}

/** The token a sweep drains to `account`, or a refusal when the call is anything else. */
const sweptToken = (call: InnerCall, executor: Address, account: Address): Address => {
  if (call.value !== 0n || call.context !== zeroHash) throw new Unreadable('sweep carries value')
  const transfer = decodeExact(erc20Abi, call.callData)
  if (transfer.functionName !== 'transfer') throw new Unreadable('sweep is not a transfer')
  const [recipient, amount] = transfer.args
  if (!isAddressEqual(recipient, account) || amount !== 0n)
    throw new Unreadable('sweep does not pay the account')
  checkBalanceRead(call, executor, 'sweep')
  return getAddress(call.target)
}

/** An approval's spender: its amount is zero, or the Executor's own balance of the token. */
const approvedSpender = (call: InnerCall, executor: Address): Address => {
  const approve = decodeExact(erc20Abi, call.callData)
  if (approve.functionName !== 'approve') throw new Unreadable('approval is not approve')
  const [spender, amount] = approve.args
  if (amount !== 0n) throw new Unreadable('an approval names a fixed amount')
  if (call.placeholders.length > 0) checkBalanceRead(call, executor, 'approval')
  return spender
}

type Callback = Readonly<{ executor: Address; repayTo: Address; loanToken: Address; returns: Hex }>

/**
 * Reads the queue the protocol's callback runs on the Executor: no call carries value or a callback
 * of its own, calls the Executor, or transfers a token out, and the last one approves the protocol
 * to pull the repay. Venue steps stay opaque. Returns the tokens it approves, which must all be swept.
 */
const callbackApprovals = (data: Hex, callback: Callback): Address[] => {
  const [queue, returned] = decodeAbiParameters(CALLBACK_ABI, data)
  if (encodeAbiParameters(CALLBACK_ABI, [queue, returned]).toLowerCase() !== data.toLowerCase())
    throw new Unreadable('callback data is not canonical')
  if (returned.toLowerCase() !== callback.returns.toLowerCase())
    throw new Unreadable('callback does not return the success value')
  const approved = new Set<Address>()
  let repays = false
  for (const entry of queue) {
    const call = innerCall(entry)
    if (
      call.value !== 0n ||
      call.context !== zeroHash ||
      isAddressEqual(call.target, callback.executor)
    )
      throw new Unreadable('a callback call carries value or a callback, or calls the Executor')
    const selector = call.callData.slice(0, 10).toLowerCase()
    if (selector === TRANSFER || selector === TRANSFER_FROM)
      throw new Unreadable('the callback transfers a token')
    if (selector !== APPROVE) {
      if (VAULT_EXITS.has(selector)) checkVaultExit(call, callback.executor)
      checkStepPlaceholders(call, callback.executor)
      repays = false
      continue
    }
    const spender = approvedSpender(call, callback.executor)
    approved.add(getAddress(call.target))
    repays =
      isAddressEqual(call.target, callback.loanToken) &&
      isAddressEqual(spender, callback.repayTo) &&
      call.placeholders.length > 0
  }
  if (!repays)
    throw new Unreadable('the callback does not end approving the protocol to pull the repay')
  return [...approved]
}

/** Every trailing call must sweep a distinct token to the account, and `required` must be among them. */
const readSweeps = (
  calls: readonly Hex[],
  required: readonly Address[],
  executor: Address,
  account: Address
): ValidatorReading => {
  const swept = new Set<Address>()
  for (const sweep of calls) {
    const token = sweptToken(innerCall(sweep), executor, account)
    if (swept.has(token)) return refuse('a token is swept twice')
    swept.add(token)
  }
  return required.every(token => swept.has(getAddress(token)))
    ? NOTHING
    : refuse('the tokens it touches are not all swept to the account')
}

type Context = Readonly<{ executor: Address; account: Address; chainId: number }>

/** Blue pays the seized collateral to its caller, the Executor, and calls it back there. */
const readBlue = (
  call: InnerCall,
  rest: readonly Hex[],
  morpho: Address,
  { executor, account }: Context
): ValidatorReading => {
  const liquidation = decodeExact(MorphoAbi, call.callData)
  if (liquidation.functionName !== 'liquidate') return refuse('first call is not liquidate')
  const [market, , , , callbackData] = liquidation.args
  if (call.context.toLowerCase() !== contextOf(morpho, BLUE_CALLBACK_DATA_INDEX))
    return refuse('seized collateral is not received and called back on the Executor')
  const approved = callbackApprovals(callbackData, {
    executor,
    repayTo: morpho,
    loanToken: market.loanToken,
    returns: '0x'
  })
  return readSweeps(
    rest,
    [market.loanToken, market.collateralToken, ...approved],
    executor,
    account
  )
}

/**
 * Midnight pays the seized collateral to the `receiver` it is told and calls back the `callback`;
 * both must be the Executor, unless the liquidation is a bad-debt write-off, which moves nothing,
 * pays its account, and calls nothing back. The market must be this chain's market on this Midnight.
 */
const readMidnight = (
  call: InnerCall,
  rest: readonly Hex[],
  midnight: Address,
  { executor, account, chainId }: Context
): ValidatorReading => {
  const liquidation = decodeExact(MidnightAbi, call.callData)
  if (liquidation.functionName !== 'liquidate') return refuse('first call is not liquidate')
  const [market, index, seized, repaid, , , receiver, callback, callbackData] = liquidation.args
  if (market.chainId !== BigInt(chainId) || !isAddressEqual(market.midnight, midnight))
    return refuse('market is not on this Midnight')
  const collateral =
    index < BigInt(market.collateralParams.length)
      ? market.collateralParams[Number(index)]
      : undefined
  if (collateral === undefined) return refuse('collateral index out of range')
  if (seized === 0n && repaid === 0n)
    return rest.length === 0 &&
      call.context === zeroHash &&
      isAddressEqual(receiver, account) &&
      isAddressEqual(callback, zeroAddress) &&
      callbackData === '0x'
      ? NOTHING
      : refuse('a write-off moves nothing and calls nothing back')
  if (
    !isAddressEqual(receiver, executor) ||
    !isAddressEqual(callback, executor) ||
    call.context.toLowerCase() !== contextOf(midnight, MIDNIGHT_CALLBACK_DATA_INDEX)
  )
    return refuse('seized collateral is not received and called back on the Executor')
  const approved = callbackApprovals(callbackData, {
    executor,
    repayTo: midnight,
    loanToken: market.loanToken,
    returns: MIDNIGHT_CALLBACK_SUCCESS
  })
  return readSweeps(rest, [market.loanToken, collateral.token, ...approved], executor, account)
}

const protocolAddress = (protocol: LiquidationProtocol) =>
  protocol.kind === 'blue' ? protocol.morpho : protocol.midnight

const readExec = (data: Hex, protocol: LiquidationProtocol, context: Context): ValidatorReading => {
  const outer = decodeExact(Executor.abi, data)
  if (outer.functionName !== 'exec_606BaXt') return refuse('not Executor.exec_606BaXt')
  const [first, ...rest] = (outer.args as readonly [readonly Hex[]])[0]
  if (first === undefined) return refuse('exec carries no call')
  const call = innerCall(first)
  if (
    call.placeholders.length > 0 ||
    call.value !== 0n ||
    !isAddressEqual(call.target, protocolAddress(protocol))
  )
    return refuse('first call is not a plain call to the protocol')
  return protocol.kind === 'blue'
    ? readBlue(call, rest, protocol.morpho, context)
    : readMidnight(call, rest, protocol.midnight, context)
}

/**
 * Claims every transaction to the shared Executor and reads it as creating no commitment: a
 * zero-value `exec_606BaXt` whose first call is the protocol's `liquidate`, whose callback makes no
 * direct `transfer` or `transferFrom`, and whose trailing calls are whole-balance transfers to the
 * account of the market's tokens and every token the callback approves; or, on Midnight, a bad-debt
 * write-off that moves nothing. Anything it
 * cannot decode exactly is refused; venue calls inside the callback stay opaque, so their router is
 * trusted (`SPEC.md`). See ADR-2026-05-28 for why the sweeps are the caller's burden on that Executor.
 */
export const executorLiquidationValidator = (config: {
  executor: Address
  protocol: LiquidationProtocol
}): Validator => ({
  id: 'executor-liquidation',
  version: 2,
  claims: payload =>
    payload.kind === 'tx' && isAddress(payload.to) && isAddressEqual(payload.to, config.executor),
  read: (payload, _witness, context) => {
    if (payload.kind !== 'tx') return refuse('only transactions are read')
    if (!isAddress(payload.to) || !isAddressEqual(payload.to, config.executor))
      return refuse('not the configured Executor')
    if (payload.value !== 0n) return refuse('an Executor call carries no value')
    if (!isAddress(context.account)) return refuse('the account is not an address')
    try {
      return readExec(payload.data as Hex, config.protocol, {
        executor: config.executor,
        account: context.account,
        chainId: context.chainId
      })
    } catch (error) {
      return refuse(error instanceof Unreadable ? error.message : 'calldata does not decode')
    }
  },
  confirm: () => true
})
