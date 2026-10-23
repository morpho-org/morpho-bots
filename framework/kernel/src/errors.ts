/** A kernel was configured with a bound it cannot enforce. */
export class KernelConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelConfigError'
  }
}

/** A kernel was started on a runner that cannot record its decisions. */
export class KernelJournalRequiredError extends Error {
  constructor() {
    super('a kernel requires a journaled runner')
    this.name = 'KernelJournalRequiredError'
  }
}
