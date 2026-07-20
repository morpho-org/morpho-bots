class ErrorWithShortMessage extends Error {
  shortMessage: string;

  constructor(message: string, shortMessage: string) {
    super(message);
    this.shortMessage = shortMessage;

    Object.setPrototypeOf(this, ErrorWithShortMessage.prototype);
  }
}

// Ensures returned value is an Error type.
export function ensureError(value: unknown): Error & { shortMessage?: string } {
  if (value instanceof Error) {
    return value;
  }

  let stringified = '[Unable to stringify thrown value]';
  try {
    stringified = JSON.stringify(value);
  } catch {
    /* empty */
  }

  const shortMessage = stringified;
  const error = new ErrorWithShortMessage(
    `This value was thrown as is, not through an Error: ${stringified}`,
    shortMessage
  );

  return error;
}

/**
 * Exhaustiveness check for switch statements
 * Ensures all cases are handled at compile time
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
