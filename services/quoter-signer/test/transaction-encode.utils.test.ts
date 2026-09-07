import type { Hex } from 'viem'

import {
  ecrecoverRatifierAbi,
  MAX_OFFER_CAP,
  midnightAbi,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { decodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'

import { parseQuoterSignerPolicy } from '../src/policy.utils'
import {
  encodeConsumeGroupsCall,
  encodeRatifyRootCall,
  encodeRevokeOperationCall
} from '../src/transaction-encode.utils'
import {
  FIXTURE_MAKER,
  FIXTURE_MIDNIGHT,
  FIXTURE_RATIFIER,
  fixturePolicyDocument
} from './policy-fixture'

const bytes32 = (byte: string) => `0x${byte.repeat(32)}` as const

const policy = parseQuoterSignerPolicy(JSON.stringify(fixturePolicyDocument()))

describe('encodeConsumeGroupsCall', () => {
  it('encodes one group as a direct setConsumed at the protocol cap with the pinned maker', () => {
    const call = encodeConsumeGroupsCall([bytes32('66')], policy)

    expect(call.to).toBe(FIXTURE_MIDNIGHT)
    expect(decodeFunctionData({ abi: midnightAbi, data: call.data })).toStrictEqual({
      functionName: 'setConsumed',
      args: [bytes32('66'), MAX_OFFER_CAP, FIXTURE_MAKER]
    })
  })

  it('encodes a batch as one singleton multicall of exact setConsumed inner calls', () => {
    const call = encodeConsumeGroupsCall([bytes32('66'), bytes32('67')], policy)

    expect(call.to).toBe(FIXTURE_MIDNIGHT)
    const outer = decodeFunctionData({ abi: midnightAbi, data: call.data })
    expect(outer.functionName).toBe('multicall')
    const inner = (outer.args as readonly [readonly Hex[]])[0]
    expect(inner.map(data => decodeFunctionData({ abi: midnightAbi, data }))).toStrictEqual([
      { functionName: 'setConsumed', args: [bytes32('66'), MAX_OFFER_CAP, FIXTURE_MAKER] },
      { functionName: 'setConsumed', args: [bytes32('67'), MAX_OFFER_CAP, FIXTURE_MAKER] }
    ])
  })
})

describe('encodeRevokeOperationCall', () => {
  it('routes consume-groups to the pinned singleton', () => {
    const call = encodeRevokeOperationCall(
      { type: 'consume-groups', groups: [bytes32('66')] },
      policy
    )

    expect(call.to).toBe(FIXTURE_MIDNIGHT)
  })

  it('encodes cancel-root as cancelRoot(maker, root) on the pinned ratifier', () => {
    const call = encodeRevokeOperationCall({ type: 'cancel-root', root: bytes32('77') }, policy)

    expect(call.to).toBe(FIXTURE_RATIFIER)
    expect(decodeFunctionData({ abi: ecrecoverRatifierAbi, data: call.data })).toStrictEqual({
      functionName: 'cancelRoot',
      args: [FIXTURE_MAKER, bytes32('77')]
    })
  })

  it('encodes unratify-root as setIsRootRatified(maker, root, false) on the pinned ratifier', () => {
    const call = encodeRevokeOperationCall({ type: 'unratify-root', root: bytes32('77') }, policy)

    expect(call.to).toBe(FIXTURE_RATIFIER)
    expect(decodeFunctionData({ abi: setterRatifierAbi, data: call.data })).toStrictEqual({
      functionName: 'setIsRootRatified',
      args: [FIXTURE_MAKER, bytes32('77'), false]
    })
  })
})

describe('encodeRatifyRootCall', () => {
  it('encodes setIsRootRatified(maker, root, true) on the pinned ratifier', () => {
    const call = encodeRatifyRootCall(bytes32('88'), policy)

    expect(call.to).toBe(FIXTURE_RATIFIER)
    expect(decodeFunctionData({ abi: setterRatifierAbi, data: call.data })).toStrictEqual({
      functionName: 'setIsRootRatified',
      args: [FIXTURE_MAKER, bytes32('88'), true]
    })
  })
})
