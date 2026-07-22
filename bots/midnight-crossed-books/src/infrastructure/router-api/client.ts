import createClient from 'openapi-fetch'

import type { paths } from './generated/router-api.types'

export function createRouterApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl })
}

export type RouterApiClient = ReturnType<typeof createRouterApiClient>
