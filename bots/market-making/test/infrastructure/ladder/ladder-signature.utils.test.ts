import type { Address } from 'viem'

import { Offer, Tree } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'bun:test'
import { createWalletClient, custom, isHex, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import { signLadderTree } from '../../../src/infrastructure/ladder/ladder-signature.utils'

const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const collateral: Address = '0x4444444444444444444444444444444444444444'
const oracle: Address = '0x5555555555555555555555555555555555555555'
const ratifier: Address = '0x6666666666666666666666666666666666666666'

describe('signLadderTree', () => {
  test('signs with the local account without requesting RPC account signing', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    let rpcRequests = 0
    const client = createWalletClient({
      account,
      chain: base,
      transport: custom({
        request: async () => {
          rpcRequests += 1
          throw new Error('RPC signing must not be requested')
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
        ratifier,
        maxAssets: 101_000_000n,
        continuousFeeCap: 0n
      })
    ])

    const signature = await signLadderTree({ tree, client, account })

    expect(isHex(signature, { strict: true })).toBe(true)
    expect(rpcRequests).toBe(0)
  })
})
