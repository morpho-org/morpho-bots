import { describe, expect, test } from 'vitest'

import {
  operatorErrorDetails,
  operatorErrorName
} from '../../src/application/operator-error-name.utils'
import { QuoterBotMonitorHaltedError } from '../../src/application/quoter-bot/quoter-bot-monitor-halted.error'
import { SetupMonitorConfigurationError } from '../../src/application/setup/setup-monitor-configuration.error'
import { SetupMonitorHaltedError } from '../../src/application/setup/setup-monitor-halted.error'
import { BootstrapConfigurationError } from '../../src/domain/bootstrap/bootstrap-configuration.error'
import { LadderConfigurationError } from '../../src/domain/ladder/ladder-configuration.error'
import { BootstrapAdapterError } from '../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapHardHaltError } from '../../src/infrastructure/bootstrap/bootstrap-hard-halt.error'
import { BootstrapMempoolValidationError } from '../../src/infrastructure/bootstrap/bootstrap-mempool-validation.error'
import { LadderAdapterError } from '../../src/infrastructure/ladder/ladder-adapter.error'
import { LadderHardHaltError } from '../../src/infrastructure/ladder/ladder-hard-halt.error'
import { MakerAccountError } from '../../src/infrastructure/make/maker-account.error'
import { ReferenceAdapterError } from '../../src/infrastructure/reference/reference-adapter.error'

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
    expect(operatorErrorName(new MakerAccountError('keystore-read'))).toBe('MakerAccountError')
    expect(operatorErrorName(new BootstrapAdapterError('position-unavailable'))).toBe(
      'BootstrapAdapterError'
    )
    expect(operatorErrorName(new LadderAdapterError('position-unavailable'))).toBe(
      'LadderAdapterError'
    )
    expect(operatorErrorName(new LadderHardHaltError([]))).toBe('LadderHardHaltError')
    expect(operatorErrorName(new ReferenceAdapterError('latest-block'))).toBe(
      'ReferenceAdapterError'
    )
  })

  test('retains only the sanitized Mempool minimum-assets detail', () => {
    const error = new BootstrapMempoolValidationError([
      { rule: 'min_offer_assets_usd', minimumAssets: 100_000_000n }
    ])

    expect(operatorErrorDetails(error)).toEqual({
      errorName: 'BootstrapMempoolValidationError',
      minimumAssets: '100000000'
    })
  })

  test('retains only allowlisted reservation cleanup diagnostics', () => {
    const error = new BootstrapAdapterError('transaction-reverted')
    error.recordReservationCleanupFailure('BootstrapAdapterError')

    expect(operatorErrorDetails(error)).toEqual({
      errorName: 'BootstrapAdapterError',
      reservationCleanupErrorName: 'BootstrapAdapterError'
    })

    error.recordReservationCleanupFailure('https://provider.example/?token=secret-token')
    expect(operatorErrorDetails(error)).toEqual({ errorName: 'BootstrapAdapterError' })
  })

  test('keeps the aggregate hard-halt classification', () => {
    expect(operatorErrorName(new BootstrapHardHaltError([]))).toBe('BootstrapHardHaltError')
  })

  test('keeps the setup-monitor configuration classification', () => {
    expect(operatorErrorName(new SetupMonitorConfigurationError())).toBe(
      'SetupMonitorConfigurationError'
    )
    expect(
      operatorErrorName(
        new SetupMonitorHaltedError({
          status: 'halted',
          reason: 'cycle-error',
          cycles: 0,
          cycleErrorName: 'UnknownError'
        })
      )
    ).toBe('SetupMonitorHaltedError')
  })

  test('keeps the combined quoter-bot monitor classification', () => {
    const error = new QuoterBotMonitorHaltedError({
      status: 'halted',
      reason: 'workflow-error',
      workflows: {
        setupCheck: { status: 'rejected', errorName: 'TypeError' },
        bootstrap: { status: 'rejected', errorName: 'TypeError' },
        ladder: { status: 'rejected', errorName: 'TypeError' }
      }
    })

    expect(operatorErrorName(error)).toBe('QuoterBotMonitorHaltedError')
  })

  test('maps hostile arbitrary names to one generic classification', () => {
    const hostile = new Error('failed')
    hostile.name = 'https://provider.example/?token=secret-token'

    expect(operatorErrorName(hostile)).toBe('UnknownError')
  })

  test('maps thrown non-Error values to one generic classification', () => {
    expect(operatorErrorName({ message: 'hostile raw text' })).toBe('UnknownError')
    expect(operatorErrorName('hostile raw string')).toBe('UnknownError')
    expect(operatorErrorName(null)).toBe('UnknownError')
  })

  test('never resolves inherited object-prototype keys as classifications', () => {
    const hostile = new Error('failed')
    hostile.name = 'toString'

    expect(operatorErrorName(hostile)).toBe('UnknownError')
  })
})
