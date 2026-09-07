import type { Attributes } from '@opentelemetry/api'

/**
 * Builds origin-only replacements for the URL span attributes of one outbound HTTP request.
 * @param request - Undici request identity carrying the origin and the origin-relative path.
 * @returns Attribute overrides keeping scheme and host while dropping path, query, and userinfo.
 * @remarks RPC providers commonly embed API keys in the URL path or query, so every URL-bearing
 * attribute is reduced to the origin unconditionally rather than per-host. Unparseable inputs
 * redact to a fixed placeholder instead of passing the raw text through.
 */
export const redactedUrlAttributes = (request: { origin: string; path: string }): Attributes => {
  let origin: string
  try {
    origin = new URL(request.path, request.origin).origin
  } catch {
    origin = '[invalid-url]'
  }
  return { 'url.full': origin, 'url.path': '[redacted]', 'url.query': '' }
}
