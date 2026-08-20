import type { Address, Hex } from 'viem'

import { decodeAbiParameters, isAddress, isAddressEqual } from 'viem'

import type { MulticallPolicy, PolicyTx } from './policy'

// One inner call must span at least selector (4 bytes) + one 32-byte argument word.
const MIN_INNER_CALL_HEX_LENGTH = 2 + 8 + 64

const decodeMulticallData = (data: Hex): readonly Hex[] | undefined => {
  try {
    const [calls] = decodeAbiParameters([{ type: 'bytes[]' }] as const, `0x${data.slice(10)}`)
    return calls
  } catch {
    return undefined
  }
}

/**
 * Deep authorization for a `multicall(bytes[])` envelope (see {@link MulticallPolicy}): returns a
 * denial reason, or `undefined` when every inner call is allowed. `evaluatePolicy` maps any return
 * or throw to a default-deny `data` decision.
 */
export const checkMulticall = (spec: MulticallPolicy, tx: PolicyTx): string | undefined => {
  const calls = decodeMulticallData(tx.data)
  if (calls === undefined) return 'calldata does not decode as multicall(bytes[])'
  if (calls.length === 0) return 'multicall bundle must not be empty'
  const allowedTargets = Object.entries(spec.innerTargetsByOuter).find(([outer]) =>
    isAddressEqual(tx.to, outer as Address)
  )?.[1]
  if (allowedTargets === undefined || allowedTargets.length === 0) {
    return `no inner targets configured for outer target ${tx.to}`
  }
  const selectors = spec.innerSelectors.map(s => s.toLowerCase())
  for (const call of calls) {
    if (call.length < MIN_INNER_CALL_HEX_LENGTH) {
      return `inner call ${call} is too short to carry a selector and an address argument`
    }
    const innerSelector = call.slice(0, 10).toLowerCase()
    if (!selectors.includes(innerSelector)) {
      return `inner selector ${innerSelector} is not allowed`
    }
    const word = call.slice(10, 74)
    const firstArg = `0x${word.slice(24)}`
    if (!/^0{24}$/.test(word.slice(0, 24)) || !isAddress(firstArg, { strict: false })) {
      return 'inner call first argument is not an address'
    }
    if (!allowedTargets.some(target => isAddressEqual(firstArg, target))) {
      return `inner call targets unregistered address ${firstArg}`
    }
  }
  return undefined
}
