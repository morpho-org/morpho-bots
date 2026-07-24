import { addressSchema } from '@repo/utils'
import { isAddress } from 'viem'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Per-collateral swap routing config (operator-tooling JSON, e.g. the seed script)
// ---------------------------------------------------------------------------
// Shape: { "<chainId>": { "<collateralToken>": <venue entry> } }, where the entry is a
// discriminated union on `venue`:
//   - { venue: 'uniswap-v3', router, fee, slippageBps }  (direct, no API key)
//   - { venue: '0x',    baseUrl?, slippageBps }           (needs ZEROX_API_KEY)
//   - { venue: '1inch', baseUrl?, slippageBps }           (needs ONEINCH_API_KEY)
//   - { venue: 'lifi',  baseUrl?, slippageBps }           (LIFI_API_KEY optional — keyless works)
//   - { venue: 'liquidswap', baseUrl?, slippageBps }      (keyless; HyperEVM only)
// The live bots infer venues from env keys and no longer read a routing file; `SwapConfigEntry` is
// still the shape the venue adapters dispatch on, and `parseSwapConfig` still validates the JSON the
// operator tooling (midnight's seed script) consumes. API keys NEVER live here — they come from env.

const slippageBps = z.number().int().min(0).max(10_000)

const uniswapV3Venue = z
  .object({
    venue: z.literal('uniswap-v3'),
    router: addressSchema,
    fee: z.number().int().positive(),
    slippageBps
  })
  .strict()
const zeroxVenue = z
  .object({ venue: z.literal('0x'), baseUrl: z.string().url().optional(), slippageBps })
  .strict()
const oneInchVenue = z
  .object({ venue: z.literal('1inch'), baseUrl: z.string().url().optional(), slippageBps })
  .strict()
const lifiVenue = z
  .object({ venue: z.literal('lifi'), baseUrl: z.string().url().optional(), slippageBps })
  .strict()
const liquidSwapVenue = z
  .object({ venue: z.literal('liquidswap'), baseUrl: z.string().url().optional(), slippageBps })
  .strict()

// A pre-venue entry ({ router, fee, slippageBps }, no `venue`) defaults to uniswap-v3, so existing
// configs keep parsing byte-identically.
const swapParamsSchema = z.preprocess(
  value =>
    value && typeof value === 'object' && !Array.isArray(value) && !('venue' in value)
      ? { venue: 'uniswap-v3', ...value }
      : value,
  z.discriminatedUnion('venue', [
    uniswapV3Venue,
    zeroxVenue,
    oneInchVenue,
    lifiVenue,
    liquidSwapVenue
  ])
)

/** One collateral's parsed venue entry — the discriminated union the adapters dispatch on. */
export type SwapConfigEntry = z.infer<typeof swapParamsSchema>

const swapConfigSchema = z.record(
  z.string().regex(/^\d+$/, 'Swap config keys must be numeric chain ids'),
  z.record(
    z
      .string()
      .refine(value => isAddress(value, { strict: false }), 'Invalid collateral token address'),
    swapParamsSchema
  )
)

/** The full parsed swap-routing file: chainId → collateral address → venue entry. */
type SwapConfig = z.infer<typeof swapConfigSchema>

/**
 * Parses (and validates) the raw JSON swap-routing config. Throws a `ZodError` on any malformed
 * entry — a present-but-invalid file is operator error and must fail loud.
 */
export function parseSwapConfig(raw: unknown): SwapConfig {
  return swapConfigSchema.parse(raw)
}
