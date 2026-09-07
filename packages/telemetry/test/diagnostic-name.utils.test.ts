import { describe, expect, test } from 'vitest'

import { diagnosticErrorName } from '../src/diagnostic-name.utils'

describe('diagnosticErrorName', () => {
  test('keeps the leading classification token only', () => {
    expect(
      diagnosticErrorName('OTLPExporterError: Not Found http://collector:4318/v1/traces')
    ).toBe('OTLPExporterError')
  })

  test('stops at dots so no hostname fragment survives', () => {
    expect(diagnosticErrorName('api.example.com refused the export')).toBe('api')
  })

  test('never passes through URLs', () => {
    expect(diagnosticErrorName('https://user:secret@collector.example/v1/traces failed')).toBe(
      'https'
    )
  })

  test('non-string and empty diagnostics fall back to a fixed name', () => {
    expect(diagnosticErrorName(undefined)).toBe('OtelDiagnostic')
    expect(diagnosticErrorName({ message: 'boom' })).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('   ')).toBe('OtelDiagnostic')
  })

  test('caps the token length', () => {
    expect(diagnosticErrorName('a'.repeat(200))).toHaveLength(64)
  })
})
