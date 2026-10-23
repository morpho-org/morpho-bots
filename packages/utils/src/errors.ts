export class ErrorWithShortMessage extends Error {
  shortMessage: string

  constructor(message: string, shortMessage: string) {
    super(message)
    this.shortMessage = shortMessage

    Object.setPrototypeOf(this, ErrorWithShortMessage.prototype)
  }
}
