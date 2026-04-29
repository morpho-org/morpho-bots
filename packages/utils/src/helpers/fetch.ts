import type { Result } from '../types/index'

import { tryCatch } from './tryCatch'

/**
 * Safely parse a `Response` as JSON. When parsing fails, reads the body as text to detect HTML
 * error pages (e.g. Cloudflare 502/429) and extracts the `<title>` or a body snippet so that
 * callers get an actionable error message instead of `SyntaxError: Unexpected token '<'`.
 */
export async function parseJsonResponse<T>(response: Response): Promise<Result<T, Error>> {
  const text = await response.text()

  try {
    return { data: JSON.parse(text) as T, error: null }
  } catch {
    const isHtml = text.trimStart().startsWith('<')
    if (isHtml) {
      const title = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()
      const snippet = title || text.slice(0, 200)
      return {
        data: null,
        error: Error(`Upstream returned HTML (HTTP ${response.status}): ${snippet}`)
      }
    }

    return {
      data: null,
      error: Error(`Failed to parse response (HTTP ${response.status}): ${text.slice(0, 200)}`)
    }
  }
}

export async function fetchJsonResponse<T>(url: string, requestInit?: RequestInit): Promise<T> {
  const { data: response, error: fetchError } = await tryCatch(fetch(url, requestInit))

  if (fetchError || !response?.ok) {
    throw Error(`HTTP ${response?.status ?? 'network error'}: ${url}`, { cause: fetchError })
  }

  const { data, error: parseError } = await parseJsonResponse<T>(response)
  if (parseError) {
    throw Error(`Failed to parse JSON: ${url}`, { cause: parseError })
  }

  return data
}
