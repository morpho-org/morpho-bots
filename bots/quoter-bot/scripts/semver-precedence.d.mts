/**
 * Orders two versions by SemVer §11 precedence.
 * @param left - Left version.
 * @param right - Right version.
 * @returns `ascending` when left precedes right, `descending` when it follows, `equal` otherwise.
 * @throws SemverPrecedenceError when either version is not plain (pre)release semver.
 */
export declare const comparePrecedence: (
  left: string,
  right: string
) => 'ascending' | 'equal' | 'descending'
