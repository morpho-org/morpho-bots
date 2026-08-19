import type { Address } from 'viem'

/** The reallocation lens returned no row for a vault it was asked about. */
export class LensReadFailedError extends Error {
  constructor(readonly vault: Address) {
    super(`reallocation lens returned no row for vault ${vault}`)
    this.name = 'LensReadFailedError'
  }
}
