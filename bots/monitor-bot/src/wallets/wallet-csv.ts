import type { Address } from 'viem'

import { getAddress, isAddress } from 'viem'

/**
 * One wallet-CRM record: every column except the wallet-address key, keyed by its (trimmed,
 * de-duplicated) header name. Cells are trimmed strings; an empty cell becomes `''`.
 */
export type WalletCrmRecord = Record<string, string>

export interface WalletCrmRow {
  /** Checksummed wallet address — the store key. */
  address: Address
  values: WalletCrmRecord
}

interface ParsedWalletCrm {
  rows: WalletCrmRow[]
  /** Rows whose key cell was not a valid address, dropped. Surfaced so the loader can log it. */
  skippedInvalidAddress: number
  /** Later rows that re-used an already-seen address (last one wins). */
  duplicateAddresses: number
}

/** Header of the column holding the wallet address in an Attio "Wallets" export. */
const KEY_COLUMN = 'Record'

/**
 * Minimal RFC 4180 CSV parser: handles quoted fields, `""` escapes, and commas/newlines inside
 * quotes. Returns rows of raw (un-trimmed) string cells. Bare commas yield empty cells, which is
 * what Attio emits for blank columns — it only quotes cells that carry text.
 */
export function parseCsvRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Normalize CRLF/CR to LF so newline handling has a single case.
  const text = content.replace(/\r\n?/g, '\n')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  // Flush the trailing field/row unless the file ended exactly on a newline (no dangling row).
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Attio prefixes many cells with a literal tab to force spreadsheet text formatting; strip that and
 * any surrounding whitespace so keys and lookups are clean.
 */
function clean(cell: string): string {
  return cell.replace(/^\t+/, '').trim()
}

/**
 * De-duplicate header names in place so a repeated column (the Attio export ships two `Company`
 * columns) stays lossless: the first keeps its name, later ones get a ` (2)`, ` (3)`, … suffix.
 */
function dedupeHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>()
  return headers.map(header => {
    const seen = counts.get(header) ?? 0
    counts.set(header, seen + 1)
    return seen === 0 ? header : `${header} (${seen + 1})`
  })
}

/**
 * Parse an Attio wallet-CRM CSV export into address-keyed rows. The `keyColumn` cell becomes the
 * checksummed key; every other column becomes an entry in `values`. Rows whose key is not a valid
 * address are dropped (counted), and a repeated address keeps the last row (counted). Throws — so
 * the boot fails loudly — if the CSV is empty or lacks the key column.
 */
export function parseWalletCrmCsv(
  content: string,
  keyColumn: string = KEY_COLUMN
): ParsedWalletCrm {
  const [headerRow, ...dataRows] = parseCsvRows(content)
  if (!headerRow) {
    throw new Error('wallet CRM CSV is empty')
  }
  const headers = dedupeHeaders(headerRow.map(clean))
  const keyIndex = headers.indexOf(keyColumn)
  if (keyIndex === -1) {
    throw new Error(
      `wallet CRM CSV is missing the "${keyColumn}" column; found: ${headers.join(', ')}`
    )
  }

  // Map keeps insertion order and dedupes addresses (last wins) in one pass.
  const byAddress = new Map<Address, WalletCrmRecord>()
  let skippedInvalidAddress = 0
  let duplicateAddresses = 0

  for (const rawRow of dataRows) {
    const cells = rawRow.map(clean)
    // Skip fully blank rows (trailing-newline artifacts, stray separators).
    if (cells.every(cell => cell === '')) {
      continue
    }
    // A row shorter than keyIndex has no address cell — `?? ''` makes it fail the check below.
    const rawAddress = cells[keyIndex] ?? ''
    // strict:false accepts the all-lowercase addresses Attio exports (no EIP-55 checksum casing).
    if (!isAddress(rawAddress, { strict: false })) {
      skippedInvalidAddress++
      continue
    }
    const address = getAddress(rawAddress)
    const values: WalletCrmRecord = {}
    headers.forEach((header, c) => {
      if (c === keyIndex) {
        return
      }
      values[header] = cells[c] ?? ''
    })
    if (byAddress.has(address)) {
      duplicateAddresses++
    }
    byAddress.set(address, values)
  }

  const rows = [...byAddress.entries()].map(([address, values]) => ({ address, values }))
  return { rows, skippedInvalidAddress, duplicateAddresses }
}
