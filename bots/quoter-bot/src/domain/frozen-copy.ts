const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Deep-copies plain data and freezes every level, so no reference to the original can change it.
 * @param value - Plain data: objects, arrays, and primitives including `bigint`.
 * @returns An independent, deeply frozen copy.
 */
export const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value))
