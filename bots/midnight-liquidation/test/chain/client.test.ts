import type { Client } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'
import { base } from 'viem/chains'

import { assertContractDeployed, createDeploylessClient } from '../../src/chain/client'

const RPC = 'http://localhost:8545'
const ADDRESS = getAddress('0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854')

// Minimal client whose eth_getCode returns `code` — enough to drive getCode without a network.
function stubClient(code: string): Client {
  return { request: async () => code } as unknown as Client
}

describe('createDeploylessClient', () => {
  it('wraps the RPC in viem-dlc deployless transport on the configured chain', () => {
    const client = createDeploylessClient({ chain: base, rpcUrl: RPC, rpcUrlFallback: undefined })
    expect(client.transport.type).toBe('viem-dlc-deployless')
    expect(client.chain?.id).toBe(base.id)
  })

  it('still presents a deployless transport when a fallback RPC is configured', () => {
    const client = createDeploylessClient({
      chain: base,
      rpcUrl: RPC,
      rpcUrlFallback: 'http://localhost:8546'
    })
    expect(client.transport.type).toBe('viem-dlc-deployless')
  })
})

describe('assertContractDeployed', () => {
  it('throws when the address holds no code', () => {
    expect(assertContractDeployed(stubClient('0x'), ADDRESS, 'EXECUTOOOR_ADDRESS')).rejects.toThrow(
      /EXECUTOOOR_ADDRESS/
    )
  })

  it('resolves when the address holds code', async () => {
    await expect(
      assertContractDeployed(stubClient('0x6001600101'), ADDRESS, 'EXECUTOOOR_ADDRESS')
    ).resolves.toBeUndefined()
  })
})
