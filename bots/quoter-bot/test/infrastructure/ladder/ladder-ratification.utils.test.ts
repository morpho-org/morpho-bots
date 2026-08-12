import type { Address } from 'viem'

import { Offer, SetterRatifierUtils, Tree, setterRatifierAbi } from '@morpho-org/midnight-sdk'
import { createWalletClient, custom, decodeFunctionData, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import {
  configuredRatifierType,
  prepareLadderRatification
} from '../../../src/infrastructure/ladder/ladder-ratification.utils'

const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const collateral: Address = '0x4444444444444444444444444444444444444444'
const oracle: Address = '0x5555555555555555555555555555555555555555'
const setterRatifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'

describe('prepareLadderRatification', () => {
  test('selects only canonical Base ratifier addresses', () => {
    expect(configuredRatifierType(setterRatifier)).toBe('setter')
    expect(configuredRatifierType('0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E')).toBe('ecrecover')
    expect(() => configuredRatifierType('0x1111111111111111111111111111111111111111')).toThrow()
  })

  test('prepares Setter proof items and the canonical root-approval transaction without signing', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    let rpcRequests = 0
    const client = createWalletClient({
      account,
      chain: base,
      transport: custom({
        request: async () => {
          rpcRequests += 1
          throw new Error('Setter preparation must not request RPC signing')
        }
      })
    })
    const tree = Tree.create([
      Offer.create({
        market: {
          chainId: base.id,
          midnight,
          loanToken,
          collateralParams: [
            {
              token: collateral,
              lltv: 800_000_000_000_000_000n,
              liquidationCursor: 0n,
              oracle
            }
          ],
          maturity: 2_000n,
          rcfThreshold: 0n,
          enterGate: zeroAddress,
          liquidatorGate: zeroAddress
        },
        buy: true,
        maker: account.address,
        tick: 100n,
        expiry: 2_000n,
        ratifier: setterRatifier,
        maxAssets: 101_000_000n,
        continuousFeeCap: 0n
      })
    ])

    const prepared = await prepareLadderRatification({
      type: 'setter',
      tree,
      client,
      account
    })

    expect(prepared.validation).toEqual({ type: 'setter' })
    expect(prepared.approval?.to).toBe(setterRatifier)
    expect(decodeFunctionData({ abi: setterRatifierAbi, data: prepared.approval!.data })).toEqual({
      functionName: 'setIsRootRatified',
      args: [account.address, tree.root, true]
    })
    expect(SetterRatifierUtils.decodeRatifierData(prepared.items[0]!.ratifierData).root).toBe(
      tree.root
    )
    expect(rpcRequests).toBe(0)
  })
})
