import { describe, expect, it } from 'bun:test'

import {
  arrayToSentence,
  convertSnakeToTitleCase,
  getPastTense,
  removeCommas,
  sortAlphabetically,
  titleize
} from '../../src/helpers/strings'

describe('removeCommas', () => {
  it('should remove all commas', () => {
    expect(removeCommas('1,000')).toBe('1000')
    expect(removeCommas('1,000,000')).toBe('1000000')
    expect(removeCommas('12,345.67')).toBe('12345.67')
  })

  it('should handle strings without commas', () => {
    expect(removeCommas('1000')).toBe('1000')
    expect(removeCommas('test')).toBe('test')
  })

  it('should handle empty string', () => {
    expect(removeCommas('')).toBe('')
  })

  it('should handle multiple consecutive commas', () => {
    expect(removeCommas('1,,,000')).toBe('1000')
  })
})

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

describe('arrayToSentence', () => {
  it('should handle empty array', () => {
    expect(arrayToSentence([])).toBe('')
  })

  it('should handle single item', () => {
    expect(arrayToSentence(['apple'])).toBe('apple')
  })

  it('should handle two items with "and"', () => {
    expect(arrayToSentence(['apple', 'banana'])).toBe('apple and banana')
  })

  it('should handle three or more items with Oxford comma', () => {
    expect(arrayToSentence(['apple', 'banana', 'orange'])).toBe('apple, banana, and orange')
    expect(arrayToSentence(['one', 'two', 'three', 'four'])).toBe('one, two, three, and four')
  })

  it('should handle array with undefined values', () => {
    expect(arrayToSentence([undefined as any])).toBe('')
  })
})

describe('sortAlphabetically', () => {
  it('should sort strings alphabetically', () => {
    expect(['banana', 'apple', 'cherry'].toSorted(sortAlphabetically)).toEqual([
      'apple',
      'banana',
      'cherry'
    ])
  })

  it('should return -1 when first string comes before second', () => {
    expect(sortAlphabetically('a', 'b')).toBe(-1)
  })

  it('should return 1 when first string comes after second', () => {
    expect(sortAlphabetically('b', 'a')).toBe(1)
  })

  it('should return 0 when strings are equal', () => {
    expect(sortAlphabetically('a', 'a')).toBe(0)
  })

  it('should handle case-sensitive sorting', () => {
    expect(sortAlphabetically('A', 'a')).toBe(-1)
  })
})

describe('getPastTense', () => {
  it('should handle irregular verbs from exceptions', () => {
    expect(getPastTense('is')).toBe('was')
    expect(getPastTense('are')).toBe('were')
    expect(getPastTense('go')).toBe('went')
    expect(getPastTense('have')).toBe('had')
    expect(getPastTense('eat')).toBe('ate')
    expect(getPastTense('run')).toBe('ran')
    expect(getPastTense('sit')).toBe('sat')
  })

  it('should handle verbs ending with "e"', () => {
    expect(getPastTense('love')).toBe('loved')
    expect(getPastTense('hope')).toBe('hoped')
    expect(getPastTense('make')).toBe('maked')
  })

  it('should handle verbs with vowel+c pattern', () => {
    expect(getPastTense('panic')).toBe('panicked')
    expect(getPastTense('picnic')).toBe('picnicked')
  })

  it('should handle verbs ending with "el"', () => {
    expect(getPastTense('travel')).toBe('traveled')
    expect(getPastTense('cancel')).toBe('canceled')
  })

  it('should handle double vowel + consonant pattern', () => {
    expect(getPastTense('need')).toBe('needed')
    expect(getPastTense('paint')).toBe('painted')
  })

  it('should handle consonant doubling pattern', () => {
    expect(getPastTense('stop')).toBe('stopped')
    expect(getPastTense('plan')).toBe('planned')
    expect(getPastTense('stir')).toBe('stirred')
  })

  it('should handle regular verbs with "ed"', () => {
    expect(getPastTense('walk')).toBe('walked')
    expect(getPastTense('talk')).toBe('talked')
    expect(getPastTense('jump')).toBe('jumped')
  })

  it('should handle exception verbs with specific endings', () => {
    expect(getPastTense('inherit')).toBe('inherited')
    expect(getPastTense('visit')).toBe('visited')
    expect(getPastTense('supply')).toBe('supplied')
  })
})

describe('titleize', () => {
  it('should convert camelCase to Title Case', () => {
    expect(titleize('camelCase')).toBe('Camel Case')
    expect(titleize('someVariableName')).toBe('Some Variable Name')
  })

  it('should convert PascalCase to Title Case', () => {
    expect(titleize('PascalCase')).toBe('Pascal Case')
    expect(titleize('MyClassName')).toBe('My Class Name')
  })

  it('should handle consecutive capitals', () => {
    expect(titleize('IOError')).toBe('IO Error')
    expect(titleize('HTTPResponse')).toBe('HTTP Response')
    expect(titleize('XMLParser')).toBe('XML Parser')
  })

  it('should handle single words', () => {
    expect(titleize('word')).toBe('Word')
    expect(titleize('Word')).toBe('Word')
    expect(titleize('WORD')).toBe('WORD')
  })

  it('should handle numbers in camelCase', () => {
    expect(titleize('var2name')).toBe('Var2name')
    expect(titleize('test123Case')).toBe('Test123 Case')
  })

  it('should handle empty string', () => {
    expect(titleize('')).toBe('')
  })

  it('should handle all lowercase', () => {
    expect(titleize('alllowercase')).toBe('Alllowercase')
  })
})
