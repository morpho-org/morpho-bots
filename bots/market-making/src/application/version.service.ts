import packageJson from '../../package.json' with { type: 'json' }

/** Application service: exposes the bot's version through the CLI adapter. */
export class VersionService {
  /**
   * Returns the bot release version.
   * @returns The package.json `version` — the same value the CalVer release tags are cut from, so
   * `mm --version` inside a published image matches its `market-making-<version>` release.
   */
  getVersion(): string {
    return packageJson.version
  }
}
