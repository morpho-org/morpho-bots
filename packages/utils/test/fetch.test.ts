import { describe, expect, it } from 'bun:test'

import { parseJsonResponse } from '../../src/helpers/fetch'

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('parseJsonResponse', () => {
  it('should parse valid JSON', async () => {
    const response = mockResponse(JSON.stringify({ id: 1 }), 200)
    const result = await parseJsonResponse<{ id: number }>(response)

    expect(result).toEqual({ data: { id: 1 }, error: null })
  })

  it('should extract title from HTML error page', async () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body></body></html>'
    const response = mockResponse(html, 502)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Upstream returned HTML (HTTP 502): 502 Bad Gateway')
  })

  it('should use body snippet when HTML has no title', async () => {
    const html = '<html><body><h1>Error</h1></body></html>'
    const response = mockResponse(html, 503)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain('Upstream returned HTML (HTTP 503)')
    expect(result.error?.message).toContain('<html>')
  })

  it('should handle non-JSON, non-HTML response', async () => {
    const response = mockResponse('Internal server error', 500)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Failed to parse response (HTTP 500): Internal server error')
  })

  it('should truncate long body snippets to 200 chars', async () => {
    const longText = 'x'.repeat(300)
    const response = mockResponse(longText, 500)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain('x'.repeat(200))
    expect(result.error?.message).not.toContain('x'.repeat(201))
  })

  it('should handle HTML with whitespace before opening tag', async () => {
    const html = '  \n  <html><head><title>429 Too Many Requests</title></head></html>'
    const response = mockResponse(html, 429)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Upstream returned HTML (HTTP 429): 429 Too Many Requests')
  })
})
