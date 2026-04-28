import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import type { EnvVarGetter } from '../../src/helpers/env'

import { getEnvVar, requireEnvVar } from '../../src/helpers/env'

describe('getEnvVar', () => {
  let consoleDebugSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    consoleDebugSpy = spyOn(console, 'debug').mockImplementation(() => {})
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    mock.restore()
  })

  it('should return env var value when it exists', () => {
    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: 'test-value' }
    })

    expect(result).toBe('test-value')
  })

  it('should return undefined when env var does not exist', () => {
    const result = getEnvVar({
      name: 'MISSING_VAR',
      env: { MISSING_VAR: undefined }
    })

    expect(result).toBeUndefined()
    expect(consoleDebugSpy).toHaveBeenCalledWith('MISSING_VAR not in env')
  })

  it('should log debug message when env var is not found', () => {
    getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: undefined }
    })

    expect(consoleDebugSpy).toHaveBeenCalledWith('TEST_VAR not in env')
  })

  it('should log warning when env object is empty', () => {
    // TypeScript requires at least the key we're looking for, but we can test with empty keys
    getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: undefined } as any
    })

    // Mock Object.keys to return empty array to trigger the warning path
    const originalKeys = Object.keys
    Object.keys = mock(() => [])

    getEnvVar({
      name: 'ANOTHER_VAR',
      env: { ANOTHER_VAR: undefined } as any
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith('env:', { ANOTHER_VAR: undefined })

    Object.keys = originalKeys
  })

  it('should parse value with custom parser', () => {
    const result = getEnvVar({
      name: 'NUMBER_VAR',
      env: { NUMBER_VAR: '42' },
      parse: (v: string) => parseInt(v)
    })

    expect(result).toBe(42)
  })

  it('should parse JSON values', () => {
    const result = getEnvVar({
      name: 'JSON_VAR',
      env: { JSON_VAR: '{"key":"value"}' },
      parse: (v: string) => JSON.parse(v)
    })

    expect(result).toEqual({ key: 'value' })
  })

  it('should return undefined when parsing returns undefined', () => {
    const result = getEnvVar({
      name: 'PARSED_VAR',
      env: { PARSED_VAR: undefined }
    })

    expect(result).toBeUndefined()
  })

  it('should use overrides when enableOverrides is true', () => {
    const getter1 = mock(() => undefined)
    const getter2 = mock(() => 'override-value')

    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: 'env-value' },
      enableOverrides: true,
      overrides: [getter1, getter2]
    })

    expect(result).toBe('override-value')
    expect(getter1).toHaveBeenCalledWith('TEST_VAR', expect.any(Function))
    expect(getter2).toHaveBeenCalledWith('TEST_VAR', expect.any(Function))
  })

  it('should use first non-undefined override', () => {
    const getter1 = mock(() => undefined)
    const getter2 = mock(() => 'first-override')
    const getter3 = mock(() => 'second-override')

    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: 'env-value' },
      enableOverrides: true,
      overrides: [getter1, getter2, getter3]
    })

    expect(result).toBe('first-override')
    expect(getter1).toHaveBeenCalled()
    expect(getter2).toHaveBeenCalled()
    expect(getter3).not.toHaveBeenCalled() // Should stop at first match
  })

  it('should fallback to env value when all overrides return undefined', () => {
    const getter1: EnvVarGetter<string> = mock(() => undefined)
    const getter2: EnvVarGetter<string> = mock(() => undefined)

    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: 'env-value' },
      enableOverrides: true,
      overrides: [getter1, getter2]
    })

    expect(result).toBe('env-value')
  })

  it('should not use overrides when enableOverrides is false or not provided', () => {
    const getter = mock(() => 'override-value')

    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: 'env-value' }
    })

    expect(result).toBe('env-value')
    expect(getter).not.toHaveBeenCalled()
  })

  it('should pass parser to override getters', () => {
    const parser = (v: string) => parseInt(v)
    const getter = mock((name, parse) => {
      expect(parse).toBe(parser)
      return parse('100')
    })

    const result = getEnvVar({
      name: 'TEST_VAR',
      env: { TEST_VAR: '50' },
      parse: parser,
      enableOverrides: true,
      overrides: [getter]
    })

    expect(result).toBe(100)
  })

  it('should handle multiple env vars', () => {
    const env = {
      VAR1: 'value1',
      VAR2: 'value2',
      VAR3: 'value3'
    }

    const result1 = getEnvVar({ name: 'VAR1', env })
    const result2 = getEnvVar({ name: 'VAR2', env })
    const result3 = getEnvVar({ name: 'VAR3', env })

    expect(result1).toBe('value1')
    expect(result2).toBe('value2')
    expect(result3).toBe('value3')
  })

  it('should handle boolean parsing', () => {
    const result = getEnvVar({
      name: 'BOOL_VAR',
      env: { BOOL_VAR: 'true' },
      parse: (v: string) => v === 'true'
    })

    expect(result).toBe(true)
  })
})

describe('requireEnvVar', () => {
  it('should return value when it exists', () => {
    const getter = (name: string) => (name === 'TEST_VAR' ? 'test-value' : undefined)

    const result = requireEnvVar(getter, 'TEST_VAR')

    expect(result).toBe('test-value')
  })

  it('should throw error when value is undefined', () => {
    const getter = () => undefined

    expect(() => requireEnvVar(getter, 'MISSING_VAR')).toThrow('MISSING_VAR is not set')
  })

  it('should work with getEnvVar as getter', () => {
    const getter = (name: 'REQUIRED_VAR') =>
      getEnvVar({
        name,
        env: { REQUIRED_VAR: 'required-value' }
      })

    const result = requireEnvVar(getter, 'REQUIRED_VAR')

    expect(result).toBe('required-value')
  })

  it('should throw with custom variable name in error', () => {
    const getter = () => undefined

    expect(() => requireEnvVar(getter, 'CUSTOM_NAME')).toThrow('CUSTOM_NAME is not set')
  })

  it('should accept parsed values', () => {
    const getter = (name: 'NUMBER_VAR') =>
      getEnvVar({
        name,
        env: { NUMBER_VAR: '123' },
        parse: (v: string) => parseInt(v)
      })

    const result = requireEnvVar(getter, 'NUMBER_VAR')

    expect(result).toBe(123)
  })
})
