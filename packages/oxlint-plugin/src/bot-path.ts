import path from 'node:path'

/**
 * The file's path segments below the lint `cwd`, so a directory the checkout itself sits in (CI
 * clones into `.../bots/bots`) never matches a rule's directory names.
 */
export const pathSegments = (filename: string, cwd: string) =>
  path.relative(cwd, filename).split(path.sep)
