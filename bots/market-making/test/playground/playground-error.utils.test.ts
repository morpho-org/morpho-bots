import { describe, expect, test } from 'bun:test'

import { CollectionImportError } from '../../playground/collection-import.error'
import { CollectionValidationError } from '../../playground/collection-validation.error'
import { FragmentCodecError } from '../../playground/fragment-codec.error'
import { playgroundErrorMessage } from '../../playground/playground-error.utils'
import { PreviewGenerationError } from '../../playground/preview-generation.error'
import { StrictJsonError } from '../../playground/strict-json.error'
import { ConfigValidationError } from '../../src/config/config-validation.error'

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
