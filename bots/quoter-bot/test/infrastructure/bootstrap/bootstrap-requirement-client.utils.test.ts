import type { Address } from 'viem'

import { EcrecoverRatifierUtils, Offer, Tree } from '@morpho-org/midnight-sdk'
import { isHex, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { createBootstrapRequirementClient } from '../../../src/infrastructure/bootstrap/bootstrap-requirement-client.utils'

const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const collateral: Address = '0x4444444444444444444444444444444444444444'
const oracle: Address = '0x5555555555555555555555555555555555555555'
const ratifier: Address = '0x6666666666666666666666666666666666666666'

const createTree = (maker: Address) =>
  Tree.create([
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
      maker,
      tick: 100n,
      expiry: 2_000n,
      ratifier,
      maxAssets: 101_000_000n,
      continuousFeeCap: 0n
    })
  ])

describe('createBootstrapRequirementClient', () => {
  test('exposes only the exact offer-tree typed-data signing capability', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const tree = createTree(account.address)
    const client = createBootstrapRequirementClient({ account, chain: base, tree })
    const typedData = EcrecoverRatifierUtils.typedData({ tree, chainId: base.id })
    const signableTypedData = typedData as unknown as Parameters<typeof client.signTypedData>[0]

    expect(isHex(await client.signTypedData(signableTypedData), { strict: true })).toBe(true)
    expect('signTransaction' in client.account).toBe(false)
    await expect(client.signMessage({ message: 'arbitrary' })).rejects.toMatchObject({
      cause: { operation: 'requirement-signing-policy' }
    })
    await expect(
      client.signTypedData({
        ...signableTypedData,
        domain: { ...signableTypedData.domain, verifyingContract: midnight }
      })
    ).rejects.toMatchObject({ cause: { operation: 'requirement-signing-policy' } })
  })
})
