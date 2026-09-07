import { describe, expect, test } from 'vitest'

import { diagnosticErrorName } from '../src/diagnostic-name.utils'

describe('diagnosticErrorName', () => {
  test('keeps a leading error-class-shaped token only', () => {
    expect(
      diagnosticErrorName('OTLPExporterError: Not Found http://collector:4318/v1/traces')
    ).toBe('OTLPExporterError')
    expect(diagnosticErrorName('AbortError')).toBe('AbortError')
    expect(diagnosticErrorName('SocketException while exporting')).toBe('SocketException')
  })

  test('hostnames, prose, and secrets collapse to the fixed fallback', () => {
    expect(diagnosticErrorName('api.example.com refused the export')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('https://user:secret@collector.example/v1/traces failed')).toBe(
      'OtelDiagnostic'
    )
    expect(diagnosticErrorName('failed to export metrics')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('sk-live-abc123 rejected')).toBe('OtelDiagnostic')
  })

  test('non-string, empty, and over-long diagnostics fall back to the fixed name', () => {
    expect(diagnosticErrorName(undefined)).toBe('OtelDiagnostic')
    expect(diagnosticErrorName({ message: 'boom' })).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('   ')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName(`A${'a'.repeat(70)}Error happened`)).toBe('OtelDiagnostic')
  })
})
