import { describe, expect, it } from 'vitest'

import { parseCsvRows, parseWalletCrmCsv } from '../../src/wallets/wallet-csv'

// Mirrors the real Attio "Wallets" export quirks: leading tabs on cells, a duplicated `Company`
// header, unquoted empty cells (`,,`), and `""`-escaped quotes inside a quoted field.
const HEADER = '"Record ID","Record","\tDeBank URL","\tCompany","Company","\tTrader"'
const ROW_KRAKEN =
  '"b3dba9ed","\t0xc5e0e2bd8b8663c621b5051d863d072295da9720","\thttps://debank.com/x","\tKraken","\tKraken",'
const ROW_QUOTED =
  '"726ce83a","\t0x3d3eb99c278c7a50d8cf5fe7ebf0ad69066fb7d1",,,,"\tSébastien ""Bigoten"" (0x3d)"'

describe('parseCsvRows', () => {
  it('splits quoted fields and unquoted empty cells', () => {
    const rows = parseCsvRows('"a","b",,"d"')
    expect(rows).toEqual([['a', 'b', '', 'd']])
  })

  it('unescapes "" inside a quoted field', () => {
    const rows = parseCsvRows('"say ""hi"" now"')
    expect(rows).toEqual([['say "hi" now']])
  })

  it('keeps commas and newlines that are inside quotes', () => {
    const rows = parseCsvRows('"a,b","c\nd"')
    expect(rows).toEqual([['a,b', 'c\nd']])
  })

  it('handles CRLF line endings and a trailing newline without a dangling row', () => {
    const rows = parseCsvRows('"a","b"\r\n"c","d"\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })
})

describe('parseWalletCrmCsv', () => {
  const csv = [HEADER, ROW_KRAKEN, ROW_QUOTED].join('\n')

  it('keys rows by the checksummed wallet address', () => {
    const { rows } = parseWalletCrmCsv(csv)
    expect(rows.map(r => r.address)).toEqual([
      '0xC5e0E2Bd8B8663c621b5051d863D072295dA9720',
      '0x3D3eb99C278C7A50d8cf5fE7eBF0AD69066Fb7d1'
    ])
  })

  it('strips leading tabs and puts every non-key column into values', () => {
    const { rows } = parseWalletCrmCsv(csv)
    expect(rows[0]?.values).toEqual({
      'Record ID': 'b3dba9ed',
      'DeBank URL': 'https://debank.com/x',
      Company: 'Kraken',
      'Company (2)': 'Kraken',
      Trader: ''
    })
  })

  it('de-duplicates repeated headers with a numeric suffix', () => {
    const { rows } = parseWalletCrmCsv(csv)
    expect(Object.keys(rows[0]?.values ?? {})).toContain('Company')
    expect(Object.keys(rows[0]?.values ?? {})).toContain('Company (2)')
  })

  it('preserves ""-escaped quotes in a value', () => {
    const { rows } = parseWalletCrmCsv(csv)
    expect(rows[1]?.values.Trader).toBe('Sébastien "Bigoten" (0x3d)')
  })

  it('drops and counts rows whose key is not a valid address', () => {
    const withJunk = [HEADER, ROW_KRAKEN, '"x","not-an-address",,,,'].join('\n')
    const parsed = parseWalletCrmCsv(withJunk)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.skippedInvalidAddress).toBe(1)
  })

  it('keeps the last row and counts duplicates when an address repeats', () => {
    const dup =
      '"other","\t0xc5e0e2bd8b8663c621b5051d863d072295da9720","\thttps://x","\tCoinbase","\tCoinbase",'
    const parsed = parseWalletCrmCsv([HEADER, ROW_KRAKEN, dup].join('\n'))
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.duplicateAddresses).toBe(1)
    expect(parsed.rows[0]?.values.Company).toBe('Coinbase')
  })

  it('throws when the key column is absent', () => {
    expect(() => parseWalletCrmCsv('"Record ID","Company"\n"a","b"')).toThrow(
      /missing the "Record"/
    )
  })

  it('throws on empty content', () => {
    expect(() => parseWalletCrmCsv('')).toThrow(/empty/)
  })
})
