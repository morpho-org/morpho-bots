import { describe, expect, it } from 'bun:test'

import { getTokenIconUrl } from '../../src/helpers/cdn'

describe('getTokenIconUrl', () => {
  it('should generate CDN URL with lowercase symbol', () => {
    const result = getTokenIconUrl('ETH')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/eth.svg')
  })

  it('should handle already lowercase symbols', () => {
    const result = getTokenIconUrl('usdc')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/usdc.svg')
  })

  it('should handle mixed case symbols', () => {
    const result = getTokenIconUrl('WeTh')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/weth.svg')
  })

  it('should encode special characters in symbol', () => {
    const result = getTokenIconUrl('TOKEN/SYMBOL')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/token%2Fsymbol.svg')
  })

  it('should handle symbols with spaces', () => {
    const result = getTokenIconUrl('TEST TOKEN')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/test%20token.svg')
  })

  it('should handle empty string', () => {
    const result = getTokenIconUrl('')

    expect(result).toBe('https://cdn.morpho.org/assets/logos/.svg')
  })
})
