import { setTimeout as sleep } from 'node:timers/promises'

import { requireEnv } from './actions'

const GITHUB_API = 'https://api.github.com'
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 1_000

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: unknown
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

async function send(url: string, init: RequestInit): Promise<Response> {
  let last: Response | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await fetch(url, init)
    const retryable = last.status === 429 || last.status >= 500
    if (!retryable || attempt === MAX_ATTEMPTS) return last
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
  }
  return last as Response
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function headers(json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(json ? { 'Content-Type': 'application/json' } : {})
  }
}

function throwIfError(status: number, data: unknown): void {
  if (status < 400) return
  const message = (data as { message?: string } | null)?.message ?? `HTTP ${status}`
  throw new GitHubApiError(status, message, data)
}

export async function githubApi<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: object
): Promise<T> {
  const res = await send(`${GITHUB_API}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await parseBody(res)
  throwIfError(res.status, data)
  return data as T
}

export async function graphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await send(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ query, variables })
  })
  const payload = (await parseBody(res)) as {
    data?: T
    errors?: { message?: string }[]
    message?: string
  } | null
  throwIfError(res.status, payload)
  const error = payload?.errors?.[0]
  if (error) throw new GitHubApiError(res.status, error.message ?? 'GraphQL query failed', payload)
  return payload?.data as T
}

/** Every element of a list endpoint, following `Link: rel="next"` to the end. */
export async function paginate<T>(path: string): Promise<T[]> {
  const results: T[] = []
  let url: string | undefined = `${GITHUB_API}${path}${path.includes('?') ? '&' : '?'}per_page=100`
  while (url) {
    const res = await send(url, { headers: headers(false) })
    const data = await parseBody(res)
    throwIfError(res.status, data)
    if (!Array.isArray(data)) break
    results.push(...(data as T[]))
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
  }
  return results
}
