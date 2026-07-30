import { describe, expect, test } from 'bun:test'

import { operatorErrorName } from '../../src/application/operator-error-name.utils'
import { BootstrapConfigurationError } from '../../src/domain/bootstrap/bootstrap-configuration.error'
import { LadderConfigurationError } from '../../src/domain/ladder/ladder-configuration.error'
import { BootstrapAdapterError } from '../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapHardHaltError } from '../../src/infrastructure/bootstrap/bootstrap-hard-halt.error'

describe('operatorErrorName', () => {
  test('keeps a fixed known domain classification', () => {
    expect(operatorErrorName(new BootstrapConfigurationError('marketId', 'is invalid'))).toBe(
      'BootstrapConfigurationError'
    )
    expect(operatorErrorName(new LadderConfigurationError('spreadBps', 'must be even'))).toBe(
      'LadderConfigurationError'
    )
  })

  test('keeps the bootstrap adapter classification', () => {
    expect(operatorErrorName(new BootstrapAdapterError('position-unavailable'))).toBe(
      'BootstrapAdapterError'
    )
  })

  test('keeps the aggregate hard-halt classification', () => {
    expect(operatorErrorName(new BootstrapHardHaltError([]))).toBe('BootstrapHardHaltError')
  })

  test('maps hostile arbitrary names to one generic classification', () => {
    const hostile = new Error('failed')
    hostile.name = 'https://provider.example/?token=secret-token'

    expect(operatorErrorName(hostile)).toBe('UnknownError')
  })
})
