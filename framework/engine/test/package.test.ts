import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const IMPORT = /\bfrom\s+'([^']+)'/g

describe('the engine package', () => {
  it('has no runtime dependencies, so it cannot know about chains or the kernel', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toBeUndefined()
  })

  it('imports nothing but its own modules and node built-ins', () => {
    const sources = readdirSync(new URL('src/', root), {
      recursive: true,
      encoding: 'utf8'
    }).filter(path => path.endsWith('.ts'))
    const specifiers = sources.flatMap(path =>
      [...readFileSync(new URL(`src/${path}`, root), 'utf8').matchAll(IMPORT)].map(
        ([, specifier]) => specifier!
      )
    )
    expect(
      specifiers.filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    ).toStrictEqual([])
  })
})
