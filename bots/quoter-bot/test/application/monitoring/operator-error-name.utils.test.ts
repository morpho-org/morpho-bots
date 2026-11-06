import { SignerAccountError } from '@repo/kit'
import { ContractFunctionZeroDataError, HttpRequestError, UserRejectedRequestError } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  operatorAdapterOperation,
  operatorErrorName
} from '../../../src/application/monitoring/operator-error-name.utils'
import {
  QuoterReadingUnavailableError,
  QuoterRunFailedError,
  BootstrapConfigurationError,
  LadderConfigurationError,
  BootstrapAdapterError,
  ActFailedError,
  KernelRefusedError,
  OfferInvalidationAdapterError,
  KernelStopError,
  LadderAdapterError,
  ReferenceAdapterError,
  QuoterTransactionError
} from '../../../src/errors'

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
    expect(operatorErrorName(new KernelRefusedError('start'))).toBe('KernelRefusedError')
    expect(operatorErrorName(new ActFailedError('ladder', 'failed'))).toBe('ActFailedError')
    expect(operatorErrorName(new QuoterReadingUnavailableError('reference rate'))).toBe(
      'QuoterReadingUnavailableError'
    )
    expect(operatorErrorName(new KernelStopError())).toBe('KernelStopError')
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
  })

  test('keeps the kit effect classifications the kernel reports', () => {
    const feeLimit = Object.assign(new Error('cap below gas'), { name: 'FeeLimitError' })

    expect(operatorErrorName(feeLimit)).toBe('FeeLimitError')
  })

  test('keeps the quoter run classification', () => {
    const error = new QuoterRunFailedError({ status: 'halted', reason: 'graph-error' })

    expect(operatorErrorName(error)).toBe('QuoterRunFailedError')
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
      'preflight',
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
      'publication-reservation-missing',
      'unsupported-ratifier'
    ] as const) {
      expect(operatorAdapterOperation(new LadderAdapterError(operation))).toBe(operation)
    }
    for (const operation of ['offer-groups-read', 'preflight'] as const) {
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
  })

  test('ignores non-adapter failures and non-object values', () => {
    expect(operatorAdapterOperation(new TypeError('boom'))).toBeUndefined()
    expect(operatorAdapterOperation('negative-spread')).toBeUndefined()
    expect(operatorAdapterOperation(null)).toBeUndefined()
  })
})
