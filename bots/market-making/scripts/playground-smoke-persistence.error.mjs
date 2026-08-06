export class PlaygroundSmokePersistenceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlaygroundSmokePersistenceError'
  }
}
