import { describe, expect, it } from 'bun:test'

import { deploymentFailed, signerPolicy } from '../scripts/railway'

describe('Railway deployment policy', () => {
  it('fails every unsuccessful terminal deployment status', () => {
    expect(['FAILED', 'CRASHED', 'TIMEOUT'].every(deploymentFailed)).toBe(true)
    expect(deploymentFailed('SUCCESS')).toBe(false)
  })

  it('pins one signer to one chain and Executor', () => {
    const policy = JSON.parse(signerPolicy(8453, '0x2222222222222222222222222222222222222222'))
    expect(policy).toEqual({
      chainId: 8453,
      executor: '0x2222222222222222222222222222222222222222',
      maxFeePerGasWei: '300000000000',
      maxGasLimit: '15000000',
      maxDataBytes: 65536
    })
  })
})
