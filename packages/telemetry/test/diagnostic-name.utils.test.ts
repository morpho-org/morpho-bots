import { describe, expect, test } from 'vitest'

import { diagnosticErrorName } from '../src/diagnostic-name.utils'

describe('diagnosticErrorName', () => {
  test('passes only allowlisted classifications through', () => {
    expect(
      diagnosticErrorName('OTLPExporterError: Not Found http://collector:4318/v1/traces')
    ).toBe('OTLPExporterError')
    expect(diagnosticErrorName('AbortError')).toBe('AbortError')
    expect(diagnosticErrorName('SocketError: other side closed')).toBe('SocketError')
    expect(diagnosticErrorName('TypeError: fetch failed')).toBe('TypeError')
  })

  test('adversarial error-class-shaped tokens collapse to the fixed fallback', () => {
    expect(diagnosticErrorName('SecretError')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('TenantCredentialException leaked in a body')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('Sk-Live-Abc123Error')).toBe('OtelDiagnostic')
  })

  test('hostnames, prose, and secrets collapse to the fixed fallback', () => {
    expect(diagnosticErrorName('api.example.com refused the export')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('https://user:secret@collector.example/v1/traces failed')).toBe(
      'OtelDiagnostic'
    )
    expect(diagnosticErrorName('failed to export metrics')).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('sk-live-abc123 rejected')).toBe('OtelDiagnostic')
  })

  test('non-string and empty diagnostics fall back to the fixed name', () => {
    expect(diagnosticErrorName(undefined)).toBe('OtelDiagnostic')
    expect(diagnosticErrorName({ message: 'boom' })).toBe('OtelDiagnostic')
    expect(diagnosticErrorName('   ')).toBe('OtelDiagnostic')
  })
})
