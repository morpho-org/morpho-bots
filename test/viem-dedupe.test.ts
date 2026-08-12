import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every workspace member directory (`bots/*`, `packages/*`) that ships a package.json, as paths
 * relative to the repo root.
 */
const workspaceMembers = (): string[] =>
  ['bots', 'packages'].flatMap(group =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(group, entry.name))
      .filter(member => {
        try {
          readFileSync(join(repoRoot, member, 'package.json'))
          return true
        } catch {
          return false
        }
      })
  )

/** Members declaring `dependency` in any dependency field — the ones whose resolution matters. */
const membersDependingOn = (dependency: string): string[] =>
  workspaceMembers().filter(member => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, member, 'package.json'), 'utf8')
    ) as Record<string, Record<string, string> | undefined>
    return ['dependencies', 'devDependencies', 'peerDependencies'].some(
      field => manifest[field]?.[dependency] !== undefined
    )
  })

/**
 * The on-disk copy `member` resolves `dependency` to. Two members resolving different paths means
 * two separate module instances at runtime, however identical their versions.
 */
const resolvedCopy = (member: string, dependency: string): string => {
  const require = createRequire(join(repoRoot, member, 'package.json'))
  return relative(repoRoot, require.resolve(`${dependency}/package.json`))
}

// Regression guard for the staging incident of 2026-08-12: `@repo/swaps` held zod 3 while every
// other member held zod 4, so pnpm gave it its own peer-variation copy of viem (viem's transitive
// `abitype` declares an optional zod peer). The two copies export two distinct `BaseError` classes,
// so `error instanceof BaseError` in `packages/swaps/src/unwrappers/erc4626.ts` was false for every
// error thrown by a `@repo/bot-kit` client — a plain ERC20 reverting on `asset()` was rethrown as an
// infrastructure failure instead of being classified as "not a vault", and the midnight liquidator
// never liquidated a post-maturity position.
describe('workspace dependency deduplication', () => {
  // zod is what splits viem, so a split here is the leading indicator; viem is the actual footgun.
  it.each(['viem', 'zod'])('resolves a single copy of %s across the workspace', dependency => {
    const members = membersDependingOn(dependency)
    expect(members.length).toBeGreaterThan(1)

    const byCopy = new Map<string, string[]>()
    for (const member of members) {
      const copy = resolvedCopy(member, dependency)
      byCopy.set(copy, [...(byCopy.get(copy) ?? []), member])
    }

    const copies = Object.fromEntries(byCopy)
    expect(
      Object.keys(copies),
      `${dependency} resolves to ${byCopy.size} distinct copies — cross-package instanceof checks against its classes will silently fail:\n${JSON.stringify(copies, null, 2)}`
    ).toHaveLength(1)
  })
})
