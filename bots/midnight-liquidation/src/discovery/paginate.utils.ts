import type { Logger } from '@repo/bot-kit'

/** One page of a cursor-paginated list response: the raw rows plus the next cursor (`null` = last). */
export type CursorPage<T> = { cursor: string | null; data: readonly T[] }

/** Fetches one page given the previous page's cursor; `null` requests the first page. */
export type FetchPage<T> = (cursor: string | null) => Promise<CursorPage<T>>

/**
 * Walks every page of a cursor-paginated endpoint and returns the concatenated rows.
 *
 * Following the cursor is not optional for these endpoints. Stopping after the first page silently
 * truncates the result to whatever the SERVER's page size happens to be — a number that is not ours
 * to control and that neither generated spec documents (both say only "Maximum number of items to
 * return"), so no response can be assumed complete. For a candidate set that under-inclusion is a
 * liquidatable
 * position never seen; for the market whitelist it is a listed market silently dropped out of scope.
 * Neither surfaces as an error, which is why both callers share this walk rather than each deciding
 * how much of a list to read.
 *
 * `maxPages` is a runaway-cursor backstop, NOT an expected limit: reaching it means the walk stopped
 * early, so it is logged at warn with `event` naming the caller. Rows are returned in page order and
 * otherwise untouched — parsing and de-duplication belong to the caller, which knows the row shape.
 */
export const collectPages = async <T>(
  fetchPage: FetchPage<T>,
  deps: { logger: Logger; maxPages: number; event: string }
): Promise<T[]> => {
  const rows: T[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page: CursorPage<T> = await fetchPage(cursor)
    pages += 1
    rows.push(...page.data)
    cursor = page.cursor
    if (cursor && pages >= deps.maxPages) {
      deps.logger.warn(deps.event, { pages, cap: deps.maxPages, rows: rows.length })
      break
    }
  } while (cursor)

  return rows
}
