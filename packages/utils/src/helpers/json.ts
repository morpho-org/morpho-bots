/**
 * Custom replacer for JSON.stringify.
 * Converts bigint values into an object of the form { __bigint__: string }.
 */
export function bigintReplacer(_: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __bigint__: value.toString() };
  }
  return value;
}

/**
 * Custom reviver for JSON.parse.
 * Converts objects of the form { __bigint__: string } back into bigint values.
 */
export function bigIntReviver(_: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '__bigint__' in value
  ) {
    // We know value is an object with __bigint__ property here.
    const obj = value as { __bigint__: string };
    return BigInt(obj.__bigint__);
  }
  return value;
}

export type Stringifier<T = unknown> = (value: T) => string;

/** `JSON.stringify` but with bigint support */
export function stringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

export type Parser<T = unknown> = (value: string) => T | undefined;

/** `JSON.parse` but with bigint support -- returns undefined on parsing error */
// Tells TypeScript that return type is `T` in `throw` mode
export function parse<T = unknown>(value: string, errorHandling: 'throw'): T;
// Tells TypeScript that return type is `T | undefined` otherwise
export function parse<T = unknown>(value: string, errorHandling?: undefined): T | undefined;
// Implementation (must cover both cases)
export function parse<T = unknown>(value: string, errorHandling?: 'throw') {
  if (errorHandling === 'throw') {
    return JSON.parse(value, bigIntReviver) as T;
  }

  try {
    return JSON.parse(value, bigIntReviver) as T;
  } catch {
    return undefined;
  }
}
