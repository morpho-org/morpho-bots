/** Signals a sanitized YAML configuration file selection, access, size, or structure failure. */
export class ConfigFileError extends Error {
  readonly code = 'CONFIG_FILE_ERROR'
  readonly kind = 'configuration'

  /**
   * Creates an operator-safe file failure without retaining paths or file contents.
   * @param reason - Stable reason code used to select the sanitized error message.
   */
  constructor(
    readonly reason:
      | 'missing-explicit'
      | 'unreadable-explicit'
      | 'unreadable-discovered'
      | 'unsupported-extension'
      | 'too-large'
      | 'empty'
      | 'malformed'
      | 'invalid-root'
      | 'unknown-key'
  ) {
    const messages = {
      'missing-explicit': 'Explicit configuration file does not exist',
      'unreadable-explicit': 'Explicit configuration file is unreadable',
      'unreadable-discovered': 'Discovered configuration file is unreadable',
      'unsupported-extension': 'Explicit configuration file must use a .yaml or .yml extension',
      'too-large': 'Configuration file exceeds the maximum supported size',
      empty: 'Configuration file must not be empty',
      malformed: 'Configuration file contains malformed YAML',
      'invalid-root': 'Configuration file root must be a mapping',
      'unknown-key': 'Configuration file contains an unsupported key'
    } as const
    super(messages[reason])
    this.name = 'ConfigFileError'
  }
}
