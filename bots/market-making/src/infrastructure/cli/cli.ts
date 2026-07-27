import type { VersionService } from '../../application/version.service'

/** Infrastructure adapter: parses `mm` CLI argv and dispatches to application services. */
export class Cli {
  constructor(private readonly version: VersionService) {}

  run(argv: readonly string[]): string {
    const [command] = argv
    switch (command) {
      case '--version':
      case '-v':
        return this.version.getVersion()
      default:
        throw new Error(`Unknown command: ${command ?? '(none)'}`)
    }
  }
}
