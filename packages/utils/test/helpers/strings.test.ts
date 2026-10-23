import { describe, expect, it } from 'vitest'

import { convertSnakeToTitleCase } from '../../src/helpers/strings'

describe('convertSnakeToTitleCase', () => {
  it('should convert snake_case to Title Case', () => {
    expect(convertSnakeToTitleCase('quick_brown_fox')).toBe('Quick Brown Fox')
    expect(convertSnakeToTitleCase('hello_world')).toBe('Hello World')
  })

  it('should handle multiple underscores', () => {
    expect(convertSnakeToTitleCase('quick_brown____fox')).toBe('Quick Brown Fox')
  })

  it('should handle leading underscores', () => {
    expect(convertSnakeToTitleCase('_test_case')).toBe('Test Case')
    expect(convertSnakeToTitleCase('___hello')).toBe('Hello')
  })

  it('should handle dashes like underscores', () => {
    expect(convertSnakeToTitleCase('quick-brown-fox')).toBe('Quick Brown Fox')
    expect(convertSnakeToTitleCase('quick_brown_fox----jumps_over')).toBe(
      'Quick Brown Fox Jumps Over'
    )
  })

  it('should handle mixed case input', () => {
    expect(convertSnakeToTitleCase('UPPER_CASE')).toBe('Upper Case')
    expect(convertSnakeToTitleCase('MiXeD_CaSe')).toBe('Mixed Case')
  })

  it('should handle single words', () => {
    expect(convertSnakeToTitleCase('word')).toBe('Word')
    expect(convertSnakeToTitleCase('test')).toBe('Test')
  })
})
