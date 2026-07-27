/** The bot's own release version. Hardcoded until a real release process exists. */
export const BOT_VERSION = '0.0.0'

/** Application service: exposes the bot's version through the CLI adapter. */
export class VersionService {
  getVersion(): string {
    return BOT_VERSION
  }
}
