import { InvalidConfigurationError } from './invalid-configuration.error'

/** Raised when a simulation caller is missing, malformed, or the zero address. */
export class InvalidSimulationCallerAddressError extends InvalidConfigurationError {
  /** Creates a credential-free caller validation failure. */
  constructor() {
    super('SIMULATION_CALLER_ADDRESS must be a public non-zero EVM address')
    this.name = 'InvalidSimulationCallerAddressError'
  }
}
