import { BootstrapAdapterError } from './bootstrap-adapter.error'

/**
 * Converts the authoritative live Midnight market fee into an explicit offer cap.
 * @param market - Freshly fetched market state.
 * @returns The exact current continuous fee accepted by the bootstrap offer.
 * @throws `BootstrapAdapterError` when the provider omits or corrupts the uint32 fee.
 * @remarks The cap intentionally accepts no fee increase beyond the observed live policy.
 */
export const bootstrapContinuousFeeCap = (market: { continuousFee: unknown }) => {
  if (
    typeof market.continuousFee !== 'number' ||
    !Number.isSafeInteger(market.continuousFee) ||
    market.continuousFee < 0 ||
    market.continuousFee > 0xffff_ffff
  ) {
    throw new BootstrapAdapterError('market-continuous-fee')
  }
  return BigInt(market.continuousFee)
}
