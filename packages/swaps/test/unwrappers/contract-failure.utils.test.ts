import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError } from 'viem'
import { describe, expect, it } from 'vitest'

import { isContractLevelFailure } from '../../src/unwrappers/contract-failure.utils'

/**
 * A viem error as it arrives from a DIFFERENT copy of viem: structurally identical, but its
 * prototype chain belongs to another module instance, so every `instanceof` against this package's
 * classes is false. Plain `Error`s with the same `name`/`cause` shape reproduce that exactly — and
 * unlike a transport-level fake, nothing re-wraps them on the way to the classifier.
 */
const foreignViemError = (name: string, cause?: Error): Error => {
  const error = new Error(`${name} from another viem copy`, cause ? { cause } : undefined)
  error.name = name
  return error
}

describe('isContractLevelFailure', () => {
  it('accepts this viem copy’s own contract-level errors', () => {
    expect(isContractLevelFailure(new ExecutionRevertedError({}))).toBe(true)
    expect(
      isContractLevelFailure(
        new ContractFunctionRevertedError({ abi: [], functionName: 'asset', message: 'reverted' })
      )
    ).toBe(true)
  })

  it('accepts a contract-level error thrown by a DIFFERENT viem copy', () => {
    // The 2026-08-12 staging incident: `@repo/swaps` resolved viem via zod 3 while `@repo/bot-kit`
    // resolved it via zod 4, so the error a bot-kit client raised failed `instanceof BaseError`
    // here. cbBTC — a plain ERC20 with no `asset()` — was rethrown as an infrastructure failure
    // instead of being memoized as "not a vault", and the liquidator never got past quoting.
    const foreign = foreignViemError(
      'ContractFunctionExecutionError',
      foreignViemError('ExecutionRevertedError')
    )
    expect(foreign instanceof BaseError, 'the fake must not be an instance of this copy').toBe(
      false
    )
    expect(isContractLevelFailure(foreign)).toBe(true)
  })

  it('finds a contract-level failure nested deep in the cause chain', () => {
    const deep = foreignViemError(
      'ContractFunctionExecutionError',
      foreignViemError(
        'ContractFunctionRevertedError',
        foreignViemError('CallExecutionError', foreignViemError('RpcRequestError'))
      )
    )
    expect(isContractLevelFailure(deep)).toBe(true)
  })

  it('rejects transport-level failures so they are never memoized as not-a-vault', () => {
    const transport = foreignViemError(
      'HttpRequestError',
      foreignViemError('TimeoutError', new Error('connection refused'))
    )
    expect(isContractLevelFailure(transport)).toBe(false)
    expect(isContractLevelFailure(new Error('connection refused'))).toBe(false)
  })

  it('rejects non-Error throws and terminates on a self-referential cause', () => {
    expect(isContractLevelFailure('execution reverted')).toBe(false)
    expect(isContractLevelFailure(undefined)).toBe(false)

    const cyclic = new Error('cyclic')
    cyclic.cause = cyclic
    expect(isContractLevelFailure(cyclic)).toBe(false)
  })
})
