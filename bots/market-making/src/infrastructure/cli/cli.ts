import { Command, CommanderError } from 'commander'

import type { VersionService } from '../../application/version.service'

/** Infrastructure adapter: wires the `mm` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command

  constructor(version: VersionService) {
    this.program = new Command()
      .name('mm')
      .description('Morpho market making bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .exitOverride()
      .configureOutput({
        writeOut: () => {},
        writeErr: () => {}
      })
  }

  run(argv: readonly string[]): string {
    try {
      this.program.parse(argv, { from: 'user' })
    } catch (error) {
      if (error instanceof CommanderError && error.code === 'commander.version') {
        return error.message
      }
      throw new Error(error instanceof Error ? error.message : String(error), { cause: error })
    }

    throw new Error('Unknown command: (none)')
  }
}
