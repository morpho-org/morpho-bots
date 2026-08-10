import { describe, expect, test } from 'bun:test'

import { createDefaultBootstrap, createDefaultLadder } from '../../playground/model'
import {
  bootstrapConfigsValue as runtimeBootstrapConfigsValue,
  hexListValue as runtimeHexListValue,
  ladderConfigsValue as runtimeLadderConfigsValue,
  parseBytes32 as runtimeParseBytes32
} from '../../src/config/config.utils'
import {
  bootstrapConfigsValue,
  hexListValue,
  ladderConfigsValue,
  parseBytes32
} from '../../src/config/market-collections'

describe('shared market collection boundary', () => {
  test('keeps the runtime compatibility exports identical to the browser-safe implementations', () => {
    expect(runtimeBootstrapConfigsValue).toBe(bootstrapConfigsValue)
    expect(runtimeLadderConfigsValue).toBe(ladderConfigsValue)
    expect(runtimeHexListValue).toBe(hexListValue)
    expect(runtimeParseBytes32).toBe(parseBytes32)

    const marketId = createDefaultBootstrap().marketId
    const markets = [parseBytes32(marketId, 'marketId')]
    expect(runtimeBootstrapConfigsValue([createDefaultBootstrap()], markets)).toEqual(
      bootstrapConfigsValue([createDefaultBootstrap()], markets)
    )
    expect(runtimeLadderConfigsValue([createDefaultLadder()], markets)).toEqual(
      ladderConfigsValue([createDefaultLadder()], markets)
    )
  })

  test('keeps the browser model graph off runtime configuration and secret parsing modules', async () => {
    const [model, shared, runtime] = await Promise.all([
      Bun.file(new URL('../../playground/model.ts', import.meta.url)).text(),
      Bun.file(new URL('../../src/config/market-collections.ts', import.meta.url)).text(),
      Bun.file(new URL('../../src/config/config.service.ts', import.meta.url)).text()
    ])

    expect(model).not.toContain('src/config/config.utils')
    expect(model).not.toContain('config.service')
    expect(model).not.toContain('privateKey')
    expect(shared).not.toContain('config.utils')
    expect(shared).not.toContain('config.service')
    expect(shared).not.toContain('viem/accounts')
    expect(runtime).toContain("from './market-collections'")
  })
})
