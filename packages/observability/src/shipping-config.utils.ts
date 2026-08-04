/** Environment map read for the BetterStack shipping opt-in variables. */
export type Environment = Record<string, string | undefined>

/**
 * Detects a complete BetterStack shipping configuration.
 * @param env - Environment holding the opt-in shipping variables.
 * @returns Whether both the source token and ingesting host are set and non-blank.
 */
export const hasShippingConfig = (env: Environment) =>
  Boolean(env.BETTERSTACK_SOURCE_TOKEN?.trim() && env.BETTERSTACK_INGESTING_HOST?.trim())
