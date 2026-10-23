import { ConfigValidationError } from '../src/errors'
import {
  CollectionImportError,
  CollectionValidationError,
  FragmentCodecError,
  PreviewGenerationError,
  StrictJsonError
} from './errors'

/**
 * Returns the sanitized message of an allowlisted playground failure.
 *
 * @param error - Failure captured at a playground rendering or user-action boundary.
 * @returns The safe operator-authored message for an expected failure.
 * @throws The original value when the failure is unexpected so an outer boundary can report it.
 */
export const playgroundErrorMessage = (error: unknown): string => {
  if (
    error instanceof CollectionImportError ||
    error instanceof CollectionValidationError ||
    error instanceof ConfigValidationError ||
    error instanceof FragmentCodecError ||
    error instanceof PreviewGenerationError ||
    error instanceof StrictJsonError
  ) {
    return error.message
  }
  throw error
}
