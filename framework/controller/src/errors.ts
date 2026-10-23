/** A plan constructor was handed evidence its kernel domain cannot vouch for. */
export class EvidenceDefectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceDefectError'
  }
}

/** `task()` was handed a name, priority or conflict set the runtime cannot act on. */
export class TaskDefectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskDefectError'
  }
}
