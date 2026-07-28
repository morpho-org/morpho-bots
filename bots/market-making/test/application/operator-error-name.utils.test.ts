import { describe, expect, test } from 'bun:test'

import { operatorErrorName } from '../../src/application/operator-error-name.utils'
import { BootstrapConfigurationError } from '../../src/domain/bootstrap-configuration.error'
import { LadderConfigurationError } from '../../src/domain/ladder-configuration.error'

describe('operatorErrorName', () => {
  test('keeps a fixed known domain classification', () => {
    expect(operatorErrorName(new BootstrapConfigurationError('marketId', 'is invalid'))).toBe(
      'BootstrapConfigurationError'
    )
    expect(operatorErrorName(new LadderConfigurationError('spreadBps', 'must be even'))).toBe(
      'LadderConfigurationError'
    )
  })

  test('maps hostile arbitrary names to one generic classification', () => {
    const hostile = new Error('failed')
    hostile.name = 'https://provider.example/?token=secret-token'

    expect(operatorErrorName(hostile)).toBe('UnknownError')
  })
})
