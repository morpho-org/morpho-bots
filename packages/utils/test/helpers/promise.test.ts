import { describe, expect, it, mock } from 'bun:test'

import { allFulfilled } from '../../src/helpers/promise'

describe('allFulfilled', () => {
  it('returns all values when all promises fulfill', async () => {
    const result = await allFulfilled([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)])
    expect(result).toEqual([1, 2, 3])
  })

  it('filters out rejected promises', async () => {
    const result = await allFulfilled([
      Promise.resolve('a'),
      Promise.reject(new Error('fail')),
      Promise.resolve('c')
    ])
    expect(result).toEqual(['a', 'c'])
  })

  it('calls onRejected for each rejected promise with reason and index', async () => {
    const onRejected = mock()
    const error = new Error('boom')

    await allFulfilled([Promise.resolve(1), Promise.reject(error), Promise.resolve(3)], onRejected)

    expect(onRejected).toHaveBeenCalledTimes(1)
    expect(onRejected).toHaveBeenCalledWith(error, 1)
  })

  it('calls onRejected for multiple rejected promises with correct indices', async () => {
    const onRejected = mock()
    const error1 = new Error('first')
    const error2 = new Error('second')

    const result = await allFulfilled(
      [Promise.reject(error1), Promise.resolve('ok'), Promise.reject(error2)],
      onRejected
    )

    expect(result).toEqual(['ok'])
    expect(onRejected).toHaveBeenCalledTimes(2)
    expect(onRejected).toHaveBeenCalledWith(error1, 0)
    expect(onRejected).toHaveBeenCalledWith(error2, 2)
  })

  it('calls onRejected with non-Error rejection reasons', async () => {
    const onRejected = mock()

    await allFulfilled([Promise.reject('string reason'), Promise.reject(42)], onRejected)

    expect(onRejected).toHaveBeenCalledTimes(2)
    expect(onRejected).toHaveBeenCalledWith('string reason', 0)
    expect(onRejected).toHaveBeenCalledWith(42, 1)
  })

  it('does not call onRejected when all promises fulfill', async () => {
    const onRejected = mock()

    await allFulfilled([Promise.resolve(1), Promise.resolve(2)], onRejected)

    expect(onRejected).not.toHaveBeenCalled()
  })

  it('returns empty array when all promises reject', async () => {
    const result = await allFulfilled([
      Promise.reject(new Error('a')),
      Promise.reject(new Error('b'))
    ])
    expect(result).toEqual([])
  })

  it('returns empty array for empty input', async () => {
    const result = await allFulfilled([])
    expect(result).toEqual([])
  })
})
