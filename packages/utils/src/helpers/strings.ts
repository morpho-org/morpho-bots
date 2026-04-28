export function removeCommas(numStr: string) {
  return numStr.replace(/,/g, '')
}

/**
 * String Converter to convert snake_case to Title Case
 * Eg.
 * - quick_brown_fox -> Quick Brown Fox
 * - quick_brown____fox -> Quick Brown Fox
 * - quick_brown_fox----jumps_over -> Quick Brown Fox Jumps Over
 *
 */
export const convertSnakeToTitleCase = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^[-_]*(.)/, (_, c: string) => c.toUpperCase())
    .replace(/[-_]+(.)/g, (_, c: string) => ' ' + c.toUpperCase())

/**
 * Converts an array of strings into a grammatically correct sentence with proper conjunctions.
 * @param {string[]} arr - The array of strings to convert
 * @returns {string} A formatted string where items are separated by commas and the last item is joined with 'and'
 * @example
 * arrayToSentence(['apple']) // returns 'apple'
 * arrayToSentence(['apple', 'banana']) // returns 'apple and banana'
 * arrayToSentence(['apple', 'banana', 'orange']) // returns 'apple, banana, and orange'
 */
export function arrayToSentence(arr: string[]): string {
  if (arr.length === 0) return ''
  if (arr.length === 1) return arr[0] ?? ''
  if (arr.length === 2) return arr.join(' and ')

  const lastElement = arr[arr.length - 1]
  return arr.slice(0, -1).join(', ') + ', and ' + lastElement
}

/**
 * Compares two strings for alphabetical sorting.
 * @param {string} a - First string to compare
 * @param {string} b - Second string to compare
 * @returns {number} Returns -1 if a comes before b, 1 if a comes after b, or 0 if they're equal
 * @example
 * ['banana', 'apple'].sort(sortAlphabetically) // returns ['apple', 'banana']
 */
export function sortAlphabetically(a: string, b: string) {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

const exceptions = {
  are: 'were',
  eat: 'ate',
  go: 'went',
  have: 'had',
  inherit: 'inherited',
  is: 'was',
  run: 'ran',
  sit: 'sat',
  visit: 'visited',
  supply: 'supplied'
}

// grammatically predictable rules
export function getPastTense(verb: string) {
  if (Object.keys(exceptions).includes(verb)) {
    return exceptions[verb as keyof typeof exceptions]
  }

  if (/e$/i.test(verb)) {
    return verb + 'd'
  }
  if (/[aeiou]c/i.test(verb)) {
    return verb + 'ked'
  }
  // for american english only
  if (/el$/i.test(verb)) {
    return verb + 'ed'
  }
  if (/[aeio][aeiou][dlmnprst]$/.test(verb)) {
    return verb + 'ed'
  }
  if (/[aeiou][bdglmnprst]$/i.test(verb)) {
    return verb.replace(/(.+[aeiou])([bdglmnprst])/, '$1$2$2ed')
  }
  return verb + 'ed'
}

/**
 * Converts a camelCase or PascalCase string to space-separated words with each word capitalized.
 * @param {string} str - The camelCase or PascalCase string to convert
 * @returns {string} A string with spaces inserted before capital letters and each word capitalized
 * @example
 * titleize('camelCase') // returns 'Camel Case'
 * titleize('PascalCase') // returns 'Pascal Case'
 * titleize('someVariableName') // returns 'Some Variable Name'
 * titleize('IOError') // returns 'IO Error'
 */
export function titleize(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // Handle consecutive capitals like "IOError" -> "IO Error"
    .replace(/([a-z\d])([A-Z])/g, '$1 $2') // Handle normal camelCase
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim()
}
