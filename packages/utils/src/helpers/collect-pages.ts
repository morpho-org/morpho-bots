/** One page of a cursor-paginated list response: the rows plus the next cursor (`null` = last page). */
export type CursorPage<T> = { cursor: string | null; data: readonly T[] }

/** Fetches one page given the previous page's cursor; `null` requests the first page. */
export type FetchPage<T> = (cursor: string | null) => Promise<CursorPage<T>>

/** Outcome of a {@link collectPages} walk. `truncated` is the only signal that rows are missing. */
export type CollectedPages<T> = {
  /** Every row returned, in page order. Not de-duplicated — that needs the row shape. */
  rows: T[]
  /** Pages actually fetched, always at least 1. */
  pages: number
  /** `true` when the walk stopped at `maxPages` with a cursor still outstanding. */
  truncated: boolean
}

/**
 * Walks every page of a cursor-paginated endpoint and returns the concatenated rows.
 *
 * Following the cursor is not optional. Stopping after the first page silently truncates the result
 * to whatever the server's page size happens to be — a number the client does not control and that
 * these APIs do not document, so no single response can be assumed complete. The under-inclusion
 * that follows surfaces as neither an error nor an empty result, which is what makes it dangerous.
 *
 * `maxPages` is a runaway-cursor backstop, NOT an expected limit: an endpoint that never returns a
 * null cursor would otherwise loop forever. Reaching it sets `truncated`, which callers are expected
 * to report — this function deliberately does no logging so it can live below the logger in the
 * dependency graph, and because the event name and fields belong to the caller either way.
 */
export const collectPages = async <T>(
  fetchPage: FetchPage<T>,
  options: { maxPages: number }
): Promise<CollectedPages<T>> => {
  const rows: T[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page: CursorPage<T> = await fetchPage(cursor)
    pages += 1
    rows.push(...page.data)
    cursor = page.cursor
    if (cursor && pages >= options.maxPages) return { rows, pages, truncated: true }
  } while (cursor)

  return { rows, pages, truncated: false }
}
