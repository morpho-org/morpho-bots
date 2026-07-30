import type { MidnightOfferRootSignature } from '@morpho-org/morpho-sdk'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type RootRequirement = {
  action: { type: 'midnightOfferRootSignature' }
  sign: (...parameters: unknown[]) => unknown
}

/**
 * Signs only expected Midnight offer-root requirements and rejects every transaction requirement.
 * @param requirements - Untrusted runtime requirements returned by the SDK flow.
 * @param sign - Bound signer for one validated offer-root requirement.
 * @returns Signed Midnight offer roots accepted by the final SDK transaction builder.
 * @throws `BootstrapAdapterError` for every non-signature or unexpected signature requirement.
 */
export const signBootstrapRequirements = async (
  requirements: readonly unknown[],
  sign: (requirement: RootRequirement) => Promise<MidnightOfferRootSignature>
) => {
  const signatures: MidnightOfferRootSignature[] = []
  for (const requirement of requirements) {
    const candidate = requirement as Partial<RootRequirement> | null
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.sign !== 'function' ||
      candidate.action?.type !== 'midnightOfferRootSignature'
    ) {
      throw new BootstrapAdapterError('unexpected-requirement')
    }
    signatures.push(await sign(candidate as RootRequirement))
  }
  return signatures
}
