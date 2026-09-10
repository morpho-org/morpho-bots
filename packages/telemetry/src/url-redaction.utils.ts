import type { Attributes } from '@opentelemetry/api'

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/

const redactedHostname = (hostname: string) => {
  if (IPV4_PATTERN.test(hostname) || hostname.includes(':')) return hostname
  const labels = hostname.split('.')
  if (labels.length <= 2) return hostname
  return `[redacted].${labels.slice(-2).join('.')}`
}

/**
 * Builds classified-origin replacements for the URL span attributes of one outbound HTTP request.
 * @param request - Undici request identity carrying the origin and the origin-relative path.
 * @returns Attribute overrides keeping scheme, a subdomain-redacted host, and port while
 * dropping path, query, and userinfo.
 * @remarks RPC providers commonly embed API keys in the URL path or query, and some encode them
 * as hostname labels, so every URL-bearing attribute — `url.full` and `server.address` alike —
 * is redacted unconditionally rather than per-host: subdomain labels collapse to `[redacted]`
 * and only the last two hostname labels survive, which keeps the provider identity dashboards
 * group on while over-redacting multi-part public suffixes rather than ever leaking. IPv4/IPv6
 * literals and one- or two-label hosts (a compose service, localhost) pass through, ports are
 * kept, and unparseable inputs redact to a fixed placeholder instead of passing raw text. The
 * registrable domain is the deliberate boundary: it is public identity (resolvable DNS, TLS SAN,
 * visible to any network observer via SNI regardless of telemetry), so a deployment whose one- or
 * two-label hostname is itself a secret is outside this redaction's threat model — front the bot
 * with a scrubbing collector or leave telemetry off there.
 */
export const redactedUrlAttributes = (request: { origin: string; path: string }): Attributes => {
  let url: URL
  try {
    url = new URL(request.path, request.origin)
  } catch {
    return {
      'url.full': '[invalid-url]',
      'url.path': '[redacted]',
      'url.query': '',
      'server.address': '[invalid-url]'
    }
  }
  const hostname = redactedHostname(url.hostname)
  const host = url.port === '' ? hostname : `${hostname}:${url.port}`
  return {
    'url.full': `${url.protocol}//${host}`,
    'url.path': '[redacted]',
    'url.query': '',
    'server.address': hostname
  }
}
