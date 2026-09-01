import type { Logger } from '@repo/bot-kit'

/** One page of a cursor-paginated list response: the raw rows plus the next cursor (`null` = last). */
export type CursorPage = { cursor: string | null; data: readonly unknown[] }

/** Fetches one page given the previous page's cursor; `null` requests the first page. */
export type FetchPage = (cursor: string | null) => Promise<CursorPage>

/**
 * Walks every page of a cursor-paginated endpoint and returns the concatenated rows.
 *
 * Following the cursor is not optional for these endpoints. Stopping after the first page silently
 * truncates the result to whatever the SERVER's page size happens to be — a number that is not ours
 * to control and has already changed once (the generated spec still documents "max 20, default 10"
 * while the live API returns 100). For a candidate set that under-inclusion is a liquidatable
 * position never seen; for the market whitelist it is a listed market silently dropped out of scope.
 * Neither surfaces as an error, which is why both callers share this walk rather than each deciding
 * how much of a list to read.
 *
 * `maxPages` is a runaway-cursor backstop, NOT an expected limit: reaching it means the walk stopped
 * early, so it is logged at warn with `event` naming the caller. Rows are returned raw — parsing and
 * de-duplication belong to the caller, which knows the row shape.
 */
export const collectPages = async (
  fetchPage: FetchPage,
  deps: { logger: Logger; maxPages: number; event: string }
): Promise<unknown[]> => {
  const rows: unknown[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page: CursorPage = await fetchPage(cursor)
    pages += 1
    rows.push(...page.data)
    cursor = page.cursor
    if (cursor && pages >= deps.maxPages) {
      deps.logger.warn(deps.event, { pages, cap: deps.maxPages, collected: rows.length })
      break
    }
  } while (cursor)

  return rows
}
