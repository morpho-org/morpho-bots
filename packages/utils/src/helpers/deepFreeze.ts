// Recursively freezes an object and all its properties
export function deepFreeze<T>(obj: T): T {
  // Freeze the object itself
  Object.freeze(obj)

  // Recursively freeze all properties
  Object.getOwnPropertyNames(obj).forEach(prop => {
    const value = obj[prop as keyof T]
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value)
    }
  })

  return obj
}
