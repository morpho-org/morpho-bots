import { InvalidConfigError } from '../errors'

/**
 * Options for every Morpho API client, which may carry the key. Refuses a non-https base, and never
 * follows a redirect: fetch strips only `Authorization` on a cross-origin redirect, so following one
 * would leak the key (https://fetch.spec.whatwg.org/#http-redirect-fetch).
 */
export const morphoApiClientOptions = (baseUrl: string, apiKey: string | undefined) => {
  if (new URL(baseUrl).protocol !== 'https:') {
    throw new InvalidConfigError(
      'Morpho API URLs must use https: requests may carry MORPHO_API_KEY'
    )
  }
  return {
    baseUrl,
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    redirect: 'manual'
  } as const
}
