import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../../..')
const read = (path: string) => readFile(join(root, path), 'utf8')

describe('market-making playground React architecture contract', () => {
  test('mounts a real React root and contains no imperative DOM controller', async () => {
    const app = await read('bots/market-making/playground/app.tsx')
    expect(app).toContain("from 'react-dom/client'")
    expect(app).toMatch(/createRoot\([^)]*\)\.render\(/)
    expect(app).toContain("from '@tanstack/react-form'")
    expect(app).toContain("from '@tanstack/react-table'")
    expect(app).not.toMatch(/document\.(?:querySelector|createElement|createElementNS)/)
    expect(app).not.toContain('replaceChildren')
    expect(app).not.toContain('dangerouslySetInnerHTML')
  })

  test('uses one TanStack form path for full and quick editors and TanStack Table for exact rows', async () => {
    const app = await read('bots/market-making/playground/app.tsx')
    expect(app).toContain('useForm({')
    expect(app).toContain('<form.Field')
    expect(app).toContain('fieldInput(`${kind}.${index}.${field[0]}`, field)')
    expect(app).toContain('`ladder.${selectedIndex}.${key}`')
    expect(app).toMatch(/fieldInput\(\s*path,\s*quickFieldDefinition\(key\),\s*true,\s*errors\s*\)/)
    expect(app).toContain('useReactTable({')
    expect(app).toContain('getCoreRowModel: getCoreRowModel()')
    expect(app).toContain('table.getRowModel().rows')
  })

  test('declares cataloged React and TanStack dependencies and a TSX shell entry', async () => {
    const rootPackage = JSON.parse(await read('package.json'))
    const botPackage = JSON.parse(await read('bots/market-making/package.json'))
    const html = await read('bots/market-making/playground/index.html')
    for (const dependency of [
      'react',
      'react-dom',
      '@types/react',
      '@types/react-dom',
      '@tanstack/react-form',
      '@tanstack/react-table'
    ]) {
      expect(rootPackage.workspaces.catalog[dependency]).toBeString()
      const section = dependency.startsWith('@types/') ? 'devDependencies' : 'dependencies'
      expect(botPackage[section][dependency]).toBe('catalog:')
    }
    expect(html).toContain('id="root"')
    expect(html).toContain('src="./app.tsx"')
    expect(html).not.toContain('src="./app.ts"')
  })

  test('validates asynchronous file imports against form state read only after the file completes', async () => {
    const app = await read('bots/market-making/playground/app.tsx')
    expect(app).toContain('const applyFile = async (files: FileList | readonly File[]) =>')
    expect(app).toMatch(
      /const text = await file\.text\(\)[\s\S]*?generation !== importGeneration\.current[\s\S]*?form\.state\.values/
    )
    expect(app).not.toContain('applyFile(event.target.files ?? [], state)')
    expect(app).not.toContain('applyFile(event.dataTransfer.files, state)')
  })
})
