import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('bootstrap + ladder only browser contract', () => {
  test('removes runtime, secret, observability, reference, and File API surfaces', async () => {
    const app = await read('playground/app.tsx')
    for (const forbidden of [
      'SCALAR_FIELDS',
      'OBSERVABILITY_FIELDS',
      'SENSITIVE_UI_KEYS',
      'state.referenceRateBps',
      'preview-reference',
      'MAKER_PRIVATE_KEY',
      'FileList',
      'file.text()',
      'type="file"',
      'onDrop',
      'onDragEnter',
      'dragging'
    ])
      expect(app).not.toContain(forbidden)
  })

  test('renders bootstrap and ladder graphics and exactly four collection outputs', async () => {
    const app = await read('playground/app.tsx')
    expect(app).toContain('BootstrapGraphic')
    expect(app).toContain('LadderGraphic')
    expect(app).toContain('useReactTable({')
    expect(app).toContain('Bootstrap JSON')
    expect(app).toContain('Bootstrap JSON string')
    expect(app).toContain('Ladder JSON')
    expect(app).toContain('Ladder JSON string')
    for (const forbidden of ['YAML', 'Shell-safe', 'Runtime & setup', 'Observability']) {
      expect(app).not.toContain(forbidden)
    }
  })

  test('uses stable atomic fragment synchronization and paste-only import', async () => {
    const app = await read('playground/app.tsx')
    expect(app).toContain('decodePlaygroundFragment(window.location.hash)')
    expect(app).toContain("history.replaceState(null, '', nextUrl)")
    expect(app).toContain('lastFragment.current')
    expect(app).toContain('if (fragment === lastFragment.current) {')
    expect(app).toContain('Paste bootstrap, ladder, or combined JSON')
    expect(app).toContain('Apply pasted JSON')
  })

  test('browser model imports only the dedicated shared parser and pure ladder domain', async () => {
    const model = await read('playground/model.ts')
    expect(model).toContain("from '../src/config/market-collections'")
    expect(model).not.toContain('config.utils')
    for (const forbidden of [
      'MAKER_PRIVATE_KEY',
      'RPC_URL',
      "from '@repo/observability'",
      "from '@repo/logging'"
    ]) {
      expect(model).not.toContain(forbidden)
    }
  })
})
