/** Raised when Railway returns a variable list that cannot be safely interpreted. */
export class InvalidRailwayVariableListError extends Error {
  /** Creates a response-shape failure without retaining or printing variable values. */
  constructor() {
    super('Railway returned an invalid variable list')
    this.name = 'InvalidRailwayVariableListError'
  }
}
