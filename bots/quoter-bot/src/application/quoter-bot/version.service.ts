/** Application service: exposes the bot's release version through the CLI adapter. */
export class VersionService {
  /**
   * The bot's release version. `scripts/build.ts` statically replaces the
   * `process.env.QUOTER_BOT_VERSION` expression with the package.json version while bundling, so
   * built artifacts (Docker image, npm package) report their release; unbundled source runs fall
   * back to the dev placeholder.
   */
  private static readonly VERSION = process.env.QUOTER_BOT_VERSION ?? '0.0.0-dev'

  /** Returns the bot release version. @returns Stable semantic version text. */
  getVersion(): string {
    return VersionService.VERSION
  }
}
