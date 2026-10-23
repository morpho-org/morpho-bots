import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const normalize = (value: string) => value.replaceAll('\\', '/')
const packageRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))

describe('playground browser module graph', () => {
  test('uses an explicit browser-safe local allowlist and excludes runtime capabilities', async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: ['playground/app.tsx'],
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      metafile: true,
      platform: 'browser',
      target: 'es2022',
      write: false
    })
    const inputs = Object.keys(result.metafile.inputs).map(normalize)
    const local = inputs.filter(
      path =>
        path.startsWith('playground/') ||
        path.startsWith('src/') ||
        path.startsWith('../../packages/')
    )
    expect(local.toSorted()).toEqual([
      'playground/app.tsx',
      'playground/asset-format.utils.ts',
      'playground/errors.ts',
      'playground/field-visibility.utils.ts',
      'playground/model.ts',
      'playground/playground-error.utils.ts',
      'playground/reference-rate.utils.ts',
      'playground/reference-response.utils.ts',
      'playground/rung-rendering.utils.tsx',
      'src/config/market-collections.ts',
      'src/domain/bytes32.ts',
      'src/domain/cross-book.ts',
      'src/domain/frozen-copy.ts',
      'src/domain/ladder.ts',
      'src/domain/loss-factor.ts',
      'src/domain/maturity-premium.ts',
      'src/domain/position-bootstrap.ts',
      'src/domain/rate-range.ts',
      'src/errors.ts'
    ])
    for (const forbidden of [
      'config.utils',
      'config.service',
      'config-source',
      'viem/_esm/accounts/',
      '/logging/',
      '/monitoring/',
      '/observability/',
      'helpers/fetch',
      'node:',
      'react-router',
      'react-query',
      'query-core',
      'node_modules/yaml/'
    ]) {
      expect(
        inputs.some(path => path.includes(forbidden)),
        `forbidden browser input: ${forbidden}`
      ).toBe(false)
    }
  })
})
