import { tryCatch } from '@repo/utils'

// Both formatters guard toISOString: an absurd timestamp (RangeError on an invalid Date) must
// degrade to the raw number, not drop the alert.
/** `20/07/2026 - 13:02:48 UTC` — the timestamp shape of the Morpho monitoring channel. */
export function formatUtcTime(unixSeconds: number) {
  const { data } = tryCatch(() => {
    const iso = new Date(unixSeconds * 1000).toISOString()
    return `${formatUtcDate(unixSeconds)} - ${iso.slice(11, 19)} UTC`
  })
  return data ?? `${unixSeconds}`
}

/** `30/09/2026` — used for market maturities. */
export function formatUtcDate(unixSeconds: number) {
  const { data } = tryCatch(() => {
    const iso = new Date(unixSeconds * 1000).toISOString()
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
  })
  return data ?? `${unixSeconds}`
}
