import { pathToFileURL } from 'node:url'

// The error class lives in its conventional *.error.ts file; Node 24 type-strips the TypeScript
// import natively, so the CLI still runs through plain `node` with no dependencies installed.
import { SemverPrecedenceError } from './semver-precedence.error.ts'

// SemVer §11 precedence for the publish workflow's dist-tag gates. GNU `sort -V` natural-sorts
// nonnumeric prerelease identifiers (`alpha10` > `alpha2`) where SemVer compares them lexically
// (`alpha10` < `alpha2`), so the gates call this comparator instead. Dependency-free on purpose:
// it runs through plain `node` before any package install would be trustworthy. Mirrors the strict
// release-version grammar of scripts/npm-package.utils.ts (no build metadata, no leading zeroes).

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

const NUMERIC_IDENTIFIER = /^\d+$/

/**
 * Parses one strict (pre)release semver string.
 * @param {string} version - Candidate version text.
 * @returns {{ core: bigint[]; prerelease: string[] | undefined }} Core numbers and identifiers.
 * @throws {SemverPrecedenceError} When the version is not plain (pre)release semver.
 */
const parseVersion = version => {
  const match = typeof version === 'string' ? SEMVER_PATTERN.exec(version) : null
  if (!match) throw new SemverPrecedenceError()
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] === undefined ? undefined : match[4].split('.')
  }
}

/**
 * Compares one prerelease identifier pair per SemVer rule 11.4.
 * @param {string} left - Left identifier.
 * @param {string} right - Right identifier.
 * @returns {number} Negative when left is lower precedence, positive when higher, zero when equal.
 */
const compareIdentifiers = (left, right) => {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left)
  const rightNumeric = NUMERIC_IDENTIFIER.test(right)
  if (leftNumeric && rightNumeric) {
    const difference = BigInt(left) - BigInt(right)
    return difference < 0n ? -1 : difference > 0n ? 1 : 0
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Orders two versions by SemVer §11 precedence.
 * @param {string} left - Left version.
 * @param {string} right - Right version.
 * @returns {'ascending' | 'equal' | 'descending'} `ascending` when left precedes right.
 * @throws {SemverPrecedenceError} When either version is not plain (pre)release semver.
 */
export const comparePrecedence = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? 'ascending' : 'descending'
    }
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 'equal'
  if (a.prerelease === undefined) return 'descending'
  if (b.prerelease === undefined) return 'ascending'
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (order !== 0) return order < 0 ? 'ascending' : 'descending'
  }
  if (a.prerelease.length === b.prerelease.length) return 'equal'
  return a.prerelease.length < b.prerelease.length ? 'ascending' : 'descending'
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    console.log(comparePrecedence(process.argv[2], process.argv[3]))
  } catch {
    console.error('semver precedence comparison requires two plain (pre)release semver versions')
    process.exitCode = 1
  }
}
