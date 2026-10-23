export type ShippingConfigState =
  | { state: 'disabled' }
  | {
      state: 'misconfigured'
      missing: 'BETTERSTACK_SOURCE_TOKEN' | 'BETTERSTACK_INGESTING_HOST'
    }
  | { state: 'enabled' }

/** Classifies the Better Stack opt-in exactly as the runtime logger does. */
export function classifyShippingConfig(
  env: Record<string, string | undefined>
): ShippingConfigState {
  const sourceToken = env.BETTERSTACK_SOURCE_TOKEN?.trim()
  const host = env.BETTERSTACK_INGESTING_HOST?.trim()
  if (!sourceToken && !host) return { state: 'disabled' }
  if (!sourceToken) return { state: 'misconfigured', missing: 'BETTERSTACK_SOURCE_TOKEN' }
  if (!host) return { state: 'misconfigured', missing: 'BETTERSTACK_INGESTING_HOST' }
  return { state: 'enabled' }
}
