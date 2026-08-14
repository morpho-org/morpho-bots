/** Application service: exposes the bot's version through the CLI adapter. */
export class VersionService {
  /** The bot's own release version. Hardcoded until a real release process exists. */
  private static readonly VERSION = '0.0.0'

  /** Returns the bot release version. @returns Stable semantic version text. */
  getVersion(): string {
    return VersionService.VERSION
  }
}
