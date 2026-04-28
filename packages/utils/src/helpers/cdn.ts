/**
 * Generate a url for a token's svg leveraging the Morpho CDN.
 *
 * @export
 * @param {string} symbol
 * @returns {string} url of token svg resource
 */
export function getTokenIconUrl(symbol: string) {
  return `https://cdn.morpho.org/assets/logos/${encodeURIComponent(symbol.toLowerCase())}.svg`
}
