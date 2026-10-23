import { describe, expect, test } from 'vitest'

import {
  CollectionImportError,
  CollectionValidationError,
  FragmentCodecError,
  PreviewGenerationError,
  StrictJsonError
} from '../../playground/errors'
import { playgroundErrorMessage } from '../../playground/playground-error.utils'
import { ConfigValidationError } from '../../src/errors'

describe('playground expected error presentation', () => {
  test('renders only allowlisted expected failures and rethrows unexpected errors for the boundary', () => {
    const expected = [
      new CollectionImportError('Import is invalid'),
      new CollectionValidationError('Collection is invalid'),
      new FragmentCodecError('Fragment is invalid'),
      new PreviewGenerationError('Preview is unavailable'),
      new StrictJsonError('JSON is invalid'),
      new ConfigValidationError('bootstrap[0].marketId', 'invalid', 'Market ID is invalid')
    ]

    for (const error of expected) expect(playgroundErrorMessage(error)).toBe(error.message)

    const unexpected = new Error('PRIVATE_UNEXPECTED_PROVIDER_PAYLOAD')
    expect(() => playgroundErrorMessage(unexpected)).toThrow(unexpected)
  })
})
