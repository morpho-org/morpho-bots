import { createFormat } from '@morpho-org/morpho-ts'

export const formatters = {
  ...createFormat({ all: { locale: 'en-US' } })
}

export const formatInt256 = formatters.commas.readable().digits(2).createOf()
export const formatUint256 = formatters.commas.readable().digits(2).min(0).createOf()

export const formatUint256Percent = (value: bigint, digits = 2, tailingZeros = false) =>
  formatters.number.digits(digits).trailingZero(tailingZeros).unit('%').of(value, 16)

export const formatBPSPercent = (
  value: bigint | number,
  { precision = 2, trailingZeros = false }: { precision?: number; trailingZeros?: boolean } = {}
) =>
  formatters.number
    .digits(precision)
    .trailingZero(trailingZeros)
    .unit('%')
    .of(typeof value === 'number' ? BigInt(value) : value, 2)

type FormatTokenBalanceOptions = {
  digits?: number | null
  min?: number
  format?: 'short' | 'full'
}

export const formatTokenBalance = (
  value: bigint | null | undefined,
  decimals: number | null | undefined,
  symbol: string | null | undefined,
  options?: FormatTokenBalanceOptions | number | null
) => {
  const opts: FormatTokenBalanceOptions =
    typeof options === 'number' || options == null ? { digits: options ?? undefined } : options

  const { digits = 2, min, format = 'short' } = opts
  const base = format === 'full' ? formatters.commas : formatters.short

  let f = base
    .digits(digits)
    .trailingZero(false)
    .unit(symbol ?? '')
    .default('0')

  if (min != null) {
    f = f.min(min)
  } else if (format === 'short') {
    f = f.min(0.01)
  }

  return f.of(value ?? 0n, decimals ?? 18)
}

export const formatTokenBalanceFull = (
  value: bigint | null | undefined,
  decimals: number | null | undefined,
  symbol: string | null | undefined,
  digits?: number | null
) => formatTokenBalance(value, decimals, symbol, { digits: digits ?? undefined, format: 'full' })

export function formatUsdValue(value: number | string | null | undefined) {
  return formatters.short.digits(2).trailingZero(false).unit('$').default('0').of(Number(value))
}

export function formatRate(value: bigint | number | undefined) {
  if (value === undefined) return undefined
  // If it's a number, it's already a decimal (e.g., 0.05 for 5%)
  // If it's a bigint, it's in WAD format (1e18)
  if (typeof value === 'number') {
    return `${(value * 100).toFixed(2)}%`
  }
  return formatters.percent.digits(2).unit('%').of(value, 18)
}
