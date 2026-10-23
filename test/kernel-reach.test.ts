import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The only package allowed to step a kernel's reducer: the kernel, which hosts it on the engine. */
const KERNEL_CALLERS = ['framework/kernel/']

/** The reducer itself, which a bot reaches only through `declareKernel` or `startKernel`. */
const KERNEL_ENTRY = /\bcreateKernel\b/

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return ['node_modules', 'test', 'dist'].includes(entry.name) ? [] : sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })

describe('the kernel', () => {
  it('is stepped only by its host (ADR-2026-09-30, kernel)', () => {
    const groups = ['bots', 'packages', 'framework'].filter(group =>
      existsSync(join(repoRoot, group))
    )
    const offenders = groups.flatMap(group =>
      sources(join(repoRoot, group))
        .map(path => relative(repoRoot, path))
        .filter(path => !KERNEL_CALLERS.some(allowed => path.startsWith(allowed)))
        .filter(path => KERNEL_ENTRY.test(readFileSync(join(repoRoot, path), 'utf8')))
    )
    expect(offenders).toStrictEqual([])
  })
})
