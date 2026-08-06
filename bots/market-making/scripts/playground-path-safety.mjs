import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const sameIdentity = (entry, expected) =>
  Number(entry.dev) === expected.dev && Number(entry.ino) === expected.ino

const requireDirectory = async (path, label) => {
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!entry.isDirectory()) throw new Error(`${label} must be a directory: ${path}`)
  const actual = await realpath(path)
  if (actual !== path) throw new Error(`${label} has a symlink ancestor: ${path}`)
  return {
    dev: Number(entry.dev),
    ino: Number(entry.ino),
    path,
    realpath: actual
  }
}

const descendants = (parent, child) => {
  const childRelative = relative(parent, child)
  if (
    childRelative === '' ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`Expected ${child} to be below ${parent}`)
  }
  const paths = []
  let current = parent
  for (const component of childRelative.split(sep)) {
    current = join(current, component)
    paths.push(current)
  }
  return paths
}

export const captureCanonicalPathIdentity = async ({ packageRoot, playground, repoRoot }) => {
  repoRoot = resolve(repoRoot)
  packageRoot = resolve(packageRoot)
  playground = resolve(playground)
  if (playground !== join(packageRoot, 'playground')) {
    throw new Error(`Canonical playground must be ${join(packageRoot, 'playground')}`)
  }
  const paths = [repoRoot, ...descendants(repoRoot, packageRoot), playground]
  if (new Set(paths).size !== paths.length) throw new Error('Canonical path chain is malformed')
  const entries = []
  for (const [index, path] of paths.entries()) {
    entries.push(
      await requireDirectory(path, index === paths.length - 1 ? 'Playground' : 'Repository path')
    )
  }
  return { entries, packageRoot, playground: entries.at(-1), repoRoot }
}

export const revalidateCanonicalPathIdentity = async identity => {
  for (const expected of identity.entries) {
    let current
    try {
      current = await requireDirectory(expected.path, 'Canonical path')
    } catch (error) {
      throw new Error(`Canonical path was replaced or changed: ${expected.path}`, { cause: error })
    }
    if (!sameIdentity(current, expected) || current.realpath !== expected.realpath) {
      throw new Error(`Canonical path identity was replaced: ${expected.path}`)
    }
  }
  return identity
}
