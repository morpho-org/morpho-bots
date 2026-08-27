/** Signals that a semver precedence comparison received a malformed version. */
export class SemverPrecedenceError extends Error {
  /**
   * Creates a fixed-message comparison failure that never echoes the rejected input.
   * @remarks Compared values can originate from the npm registry, so the message stays constant.
   */
  constructor() {
    super('semver precedence comparison requires two plain (pre)release semver versions')
    this.name = 'SemverPrecedenceError'
  }
}
