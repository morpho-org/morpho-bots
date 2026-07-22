import createClient from 'openapi-fetch'

import type { paths } from './generated/morpho-api.types'

export function createMorphoApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl })
}

export type MorphoApiClient = ReturnType<typeof createMorphoApiClient>
