// Hard cap on pages walked in a single pagination run — a circuit breaker against a cursor that
// never resolves to null. At the API's max page size (100) this still allows 10k rows per run.
const MAX_PAGES = 100

export type Page<T> = { cursor: string | null; data: T[] }

/**
 * Walks the Midnight API's shared cursor protocol (`{ cursor, data }`), yielding every row across
 * pages. `fetchPage(cursor)` is called with `undefined` first, then the previous page's cursor;
 * iteration stops when the API returns a `null` cursor. A `fetchPage` throw propagates to the
 * caller. Exceeding {@link MAX_PAGES} throws rather than truncating silently.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>
): AsyncGenerator<T, void, unknown> {
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { cursor: next, data } = await fetchPage(cursor)
    for (const row of data) yield row
    if (next === null || next === undefined) return
    cursor = next
  }
  throw new Error(`paginate exceeded ${MAX_PAGES} pages (possible non-terminating cursor)`)
}
