import { ContractFunctionZeroDataError, HttpRequestError, UserRejectedRequestError } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  operatorAdapterOperation,
  operatorErrorDetails,
  operatorErrorName
} from '../../../src/application/monitoring/operator-error-name.utils'
import { QuoterBotMonitorHaltedError } from '../../../src/application/quoter-bot/quoter-bot-monitor-halted.error'
import { SetupMonitorConfigurationError } from '../../../src/application/setup/setup-monitor-configuration.error'
import { SetupMonitorHaltedError } from '../../../src/application/setup/setup-monitor-halted.error'
import { BootstrapConfigurationError } from '../../../src/domain/bootstrap-configuration.error'
import { LadderConfigurationError } from '../../../src/domain/ladder-configuration.error'
import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapHardHaltError } from '../../../src/infrastructure/bootstrap/bootstrap-hard-halt.error'
import { BootstrapMempoolValidationError } from '../../../src/infrastructure/bootstrap/bootstrap-mempool-validation.error'
import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { LadderHardHaltError } from '../../../src/infrastructure/ladder/ladder-hard-halt.error'
import { ReferenceAdapterError } from '../../../src/infrastructure/reference/reference-adapter.error'
import { QuoterTransactionError } from '../../../src/infrastructure/transaction/quoter-transaction.error'
import { SignerAccountError } from '../../../src/infrastructure/transaction/signer-account.error'

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
    expect(operatorErrorName(new SignerAccountError('keystore-read'))).toBe('SignerAccountError')
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

  test('keeps stable viem provider and contract-read classifications', () => {
    const rpc = new HttpRequestError({ url: 'https://rpc.example/key?secret=1', status: 429 })
    const contract = new ContractFunctionZeroDataError({ functionName: 'market' })
    const unrelated = new UserRejectedRequestError(new Error('wallet'))

    expect(operatorErrorName(rpc)).toBe('HttpRequestError')
    expect(operatorErrorName(contract)).toBe('ContractFunctionZeroDataError')
    expect(operatorErrorName(unrelated)).toBe('UnknownError')
    expect(operatorErrorDetails(rpc)).toEqual({ errorName: 'HttpRequestError' })
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
      adapterOperation: 'transaction-reverted',
      reservationCleanupErrorName: 'BootstrapAdapterError'
    })

    error.recordReservationCleanupFailure('https://provider.example/?token=secret-token')
    expect(operatorErrorDetails(error)).toEqual({
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'transaction-reverted'
    })
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

describe('operatorAdapterOperation', () => {
  test('returns an allowlisted adapter operation so a guardrail can key on the exact reason', () => {
    expect(operatorAdapterOperation(new BootstrapAdapterError('negative-spread'))).toBe(
      'negative-spread'
    )
    expect(operatorErrorDetails(new BootstrapAdapterError('negative-spread'))).toEqual({
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'negative-spread'
    })
  })

  test('returns every adapter operation so a halt names which check failed', () => {
    for (const operation of [
      'latest-block',
      'reference-history',
      'reference-uninitialized'
    ] as const) {
      expect(operatorAdapterOperation(new ReferenceAdapterError(operation))).toBe(operation)
    }
    for (const operation of [
      'reference-stale',
      'reference-checkpoint',
      'reference-rate',
      'maturity-read',
      'preflight',
      'ratifier-transaction-reverted',
      'transaction-pending',
      'transaction-dropped',
      'transaction-reverted'
    ] as const) {
      expect(operatorAdapterOperation(new BootstrapAdapterError(operation))).toBe(operation)
    }
    for (const operation of [
      'book-response',
      'book-timeout',
      'empty-ladder',
      'market-configuration-missing',
      'market-matured',
      'market-not-configured',
      'publication-reservation-missing',
      'ratifier-signature',
      'readonly-mutation',
      'removed-market-cleanup',
      'unsupported-ratifier'
    ] as const) {
      expect(operatorAdapterOperation(new LadderAdapterError(operation))).toBe(operation)
    }
    for (const operation of [
      'batch-transaction',
      'offer-groups-read',
      'ownership-cleanup',
      'preflight',
      'transaction'
    ] as const) {
      expect(operatorAdapterOperation(new OfferInvalidationAdapterError(operation))).toBe(operation)
    }
    for (const operation of [
      'configuration',
      'simulation-reverted',
      'submission-refused',
      'reconciliation-required',
      'unknown-pending-nonce'
    ] as const) {
      expect(operatorAdapterOperation(new QuoterTransactionError(operation))).toBe(operation)
    }
  })

  test('withholds an unrecognized operation so provider text can never become a dimension', () => {
    expect(
      operatorAdapterOperation(
        new BootstrapAdapterError('https://rpc.example/key?secret=1' as never)
      )
    ).toBeUndefined()
    expect(
      operatorErrorDetails(new BootstrapAdapterError('not-a-known-operation' as never))
    ).toEqual({
      errorName: 'BootstrapAdapterError'
    })
  })

  test('ignores non-adapter failures and non-object values', () => {
    expect(operatorAdapterOperation(new TypeError('boom'))).toBeUndefined()
    expect(operatorAdapterOperation('negative-spread')).toBeUndefined()
    expect(operatorAdapterOperation(null)).toBeUndefined()
  })
})
