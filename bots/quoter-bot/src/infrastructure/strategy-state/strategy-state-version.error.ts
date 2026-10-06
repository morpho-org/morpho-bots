/**
 * Signals strategy state this version cannot trust: unreadable, or written by an earlier version.
 * @remarks Its message is the whole operator procedure; see the README's "Upgrading to unit-capped
 * offers".
 */
export class StrategyStateVersionError extends Error {
  /** Creates the operator-facing failure; it carries no path or file contents. */
  constructor() {
    super(
      'Strategy state is unreadable or was written by an earlier quoter-bot version. Stop that ' +
        'version, confirm with its `invalidate --readonly` that no offer group remains, delete ' +
        'the strategy state directory ' +
        '($XDG_STATE_HOME/morpho-quoter-bot, by default ~/.local/state/morpho-quoter-bot), then ' +
        'start this version.'
    )
    this.name = 'StrategyStateVersionError'
  }
}
