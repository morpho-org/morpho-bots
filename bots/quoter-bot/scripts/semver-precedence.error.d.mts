/** Signals that a semver precedence comparison received a malformed version. */
export declare class SemverPrecedenceError extends Error {
  /**
   * Creates a fixed-message comparison failure that never echoes the rejected input.
   * @remarks Compared values can originate from the npm registry, so the message stays constant.
   */
  constructor()
}
