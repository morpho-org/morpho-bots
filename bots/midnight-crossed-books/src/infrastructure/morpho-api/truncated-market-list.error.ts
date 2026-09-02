/**
 * Raised when the listed-markets walk stopped at its page cap with a cursor still outstanding.
 *
 * The listed set is a handful of markets, so reaching the cap means the endpoint returned a runaway
 * cursor rather than that the set grew. Resolving crossed books against a silently partial market
 * list would skip real crossings with no signal, so this fails the fetch instead.
 */
export class TruncatedMarketListError extends Error {
  readonly code = 'truncated_market_list'
  readonly pages: number

  constructor(pages: number) {
    super(`Listed-markets pagination stopped at ${pages} pages with a cursor still outstanding`)
    this.name = 'TruncatedMarketListError'
    this.pages = pages
  }
}
