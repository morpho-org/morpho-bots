import { describe, expect, it } from 'bun:test'

import {
  dateLabelForUnixTimestamp,
  dateTimeLabelForUnixTimestamp,
  dateToUnixTimestamp,
  days,
  formatDuration,
  formatSecondsToUtcDate,
  fullUtcDateLabel,
  hours,
  mins,
  ms,
  oneDayInMs,
  oneDayInSecs,
  oneHourInMs,
  oneHourInSecs,
  oneMinInMs,
  oneMinInSecs,
  oneSecond,
  oneSecondInMs,
  oneWeekInMs,
  oneWeekInSecs,
  oneYearInSecs,
  secondsToZonedDateTime,
  secs,
  toJsTimestamp,
  toUnixTimestamp,
  twentyFourHoursInMs,
  twentyFourHoursInSecs
} from '../../src/helpers/time'

describe('time constants', () => {
  it('should have correct millisecond constants', () => {
    expect(oneSecondInMs).toBe(1000)
    expect(oneMinInMs).toBe(60000)
    expect(oneHourInMs).toBe(3600000)
    expect(oneDayInMs).toBe(86400000)
    expect(oneWeekInMs).toBe(604800000)
    expect(twentyFourHoursInMs).toBe(86400000)
  })

  it('should have correct second constants', () => {
    expect(oneSecond).toBe(1)
    expect(oneMinInSecs).toBe(60)
    expect(oneHourInSecs).toBe(3600)
    expect(oneDayInSecs).toBe(86400)
    expect(twentyFourHoursInSecs).toBe(86400)
    expect(oneWeekInSecs).toBe(604800)
    expect(oneYearInSecs).toBe(31536000)
  })
})

describe('hours', () => {
  it('should convert hours to seconds', () => {
    expect(hours(1).toSecs()).toBe(3600)
    expect(hours(2).toSecs()).toBe(7200)
    expect(hours(24).toSecs()).toBe(86400)
  })

  it('should handle fractional hours', () => {
    expect(hours(0.5).toSecs()).toBe(1800)
    expect(hours(1.5).toSecs()).toBe(5400)
  })

  it('should handle zero', () => {
    expect(hours(0).toSecs()).toBe(0)
  })
})

describe('days', () => {
  it('should convert days to seconds', () => {
    expect(days(1).toSecs()).toBe(86400)
    expect(days(7).toSecs()).toBe(604800)
  })

  it('should convert days to milliseconds', () => {
    expect(days(1).toMs()).toBe(86400000)
    expect(days(2).toMs()).toBe(172800000)
  })

  it('should handle fractional days', () => {
    expect(days(0.5).toSecs()).toBe(43200)
    expect(days(0.5).toMs()).toBe(43200000)
  })
})

describe('mins', () => {
  it('should convert minutes to seconds', () => {
    expect(mins(1).toSecs()).toBe(60)
    expect(mins(60).toSecs()).toBe(3600)
  })

  it('should convert minutes to milliseconds', () => {
    expect(mins(1).toMs()).toBe(60000)
    expect(mins(5).toMs()).toBe(300000)
  })

  it('should handle fractional minutes', () => {
    expect(mins(0.5).toSecs()).toBe(30)
    expect(mins(1.5).toMs()).toBe(90000)
  })
})

describe('secs', () => {
  it('should convert seconds to milliseconds', () => {
    expect(secs(1).toMs()).toBe(1000)
    expect(secs(60).toMs()).toBe(60000)
  })

  it('should handle fractional seconds', () => {
    expect(secs(0.5).toMs()).toBe(500)
    expect(secs(1.5).toMs()).toBe(1500)
  })
})

describe('ms', () => {
  it('should convert milliseconds to seconds', () => {
    expect(ms(1000).toSecs()).toBe(1)
    expect(ms(60000).toSecs()).toBe(60)
  })

  it('should handle fractional conversions', () => {
    expect(ms(500).toSecs()).toBe(0.5)
    expect(ms(1500).toSecs()).toBe(1.5)
  })
})

describe('toJsTimestamp', () => {
  it('should convert Unix timestamp to JavaScript timestamp', () => {
    expect(toJsTimestamp(1000)).toBe(1000000)
    expect(toJsTimestamp(1609459200)).toBe(1609459200000)
  })

  it('should handle zero', () => {
    expect(toJsTimestamp(0)).toBe(0)
  })
})

describe('toUnixTimestamp', () => {
  it('should convert JavaScript timestamp to Unix timestamp', () => {
    expect(toUnixTimestamp(1000000)).toBe(1000)
    expect(toUnixTimestamp(1609459200000)).toBe(1609459200)
  })

  it('should round the result', () => {
    expect(toUnixTimestamp(1500)).toBe(2)
    expect(toUnixTimestamp(1499)).toBe(1)
  })

  it('should handle zero', () => {
    expect(toUnixTimestamp(0)).toBe(0)
  })
})

describe('dateToUnixTimestamp', () => {
  it('should convert date string to Unix timestamp', () => {
    const result = dateToUnixTimestamp('2024-01-01')
    expect(result).toBeGreaterThan(1704000000)
    expect(result).toBeLessThan(1705000000)
  })

  it('should handle different date formats', () => {
    const result1 = dateToUnixTimestamp('2024-03-15')
    const result2 = dateToUnixTimestamp('March 15, 2024')

    expect(result1).toBeGreaterThan(0)
    expect(result2).toBeGreaterThan(0)
  })
})

describe('formatSecondsToUtcDate', () => {
  it('should format number of seconds to future UTC date', () => {
    const result = formatSecondsToUtcDate(3600)

    expect(result).toMatch(/\w+ \d+, \d{4} at \d+:\d+ (AM|PM) UTC/)
  })

  it('should handle string input', () => {
    const result = formatSecondsToUtcDate('7200')

    expect(result).toMatch(/\w+ \d+, \d{4} at \d+:\d+ (AM|PM) UTC/)
  })

  it('should return N/A for undefined', () => {
    expect(formatSecondsToUtcDate(undefined)).toBe('N/A')
  })

  it('should return N/A for null', () => {
    expect(formatSecondsToUtcDate(null as any)).toBe('N/A')
  })

  it('should return N/A for invalid string', () => {
    expect(formatSecondsToUtcDate('invalid')).toBe('N/A')
  })

  it('should return N/A for zero seconds', () => {
    expect(formatSecondsToUtcDate(0)).toBe('N/A')
  })

  it('should return N/A for negative seconds', () => {
    expect(formatSecondsToUtcDate(-100)).toBe('N/A')
  })

  it('should return N/A for Infinity', () => {
    expect(formatSecondsToUtcDate(Infinity)).toBe('N/A')
    expect(formatSecondsToUtcDate(-Infinity)).toBe('N/A')
  })
})

describe('secondsToZonedDateTime', () => {
  it('should convert Unix timestamp string to ZonedDateTime', () => {
    const result = secondsToZonedDateTime('1704067200')

    expect(result.year).toBe(2024)
    expect(result.month).toBe(1)
    expect(result.day).toBe(1)
    expect(result.timeZone).toBe('Etc/UTC')
  })

  it('should handle zero timestamp', () => {
    const result = secondsToZonedDateTime('0')

    expect(result.year).toBe(1970)
    expect(result.month).toBe(1)
    expect(result.day).toBe(1)
  })

  it('should preserve time components', () => {
    const timestamp = '1704110400'
    const result = secondsToZonedDateTime(timestamp)

    expect(result.hour).toBeGreaterThanOrEqual(0)
    expect(result.hour).toBeLessThan(24)
    expect(result.minute).toBeGreaterThanOrEqual(0)
    expect(result.minute).toBeLessThan(60)
  })
})

describe('dateLabelForUnixTimestamp', () => {
  it('should format Unix timestamp to date label', () => {
    const timestamp = 1704153600
    const result = dateLabelForUnixTimestamp(timestamp)

    expect(result).toMatch(/\w+ \d+, \d{4}/)
    expect(result).toContain('2024')
  })

  it('should handle zero timestamp (epoch)', () => {
    const result = dateLabelForUnixTimestamp(0)

    expect(result).toMatch(/\w+ \d+, \d{4}/)
    // Could be 1969 or 1970 depending on timezone
    expect(result).toMatch(/196[89]|1970/)
  })

  it('should format with month, day, and year', () => {
    const timestamp = 1700000000
    const result = dateLabelForUnixTimestamp(timestamp)

    expect(result).toMatch(/\w+ \d+, \d{4}/)
  })
})

describe('formatDuration', () => {
  describe('default (short + coarse)', () => {
    it('returns days when time >= 1 day, dropping sub-day remainder', () => {
      expect(formatDuration(89 * 86400)).toBe('89d')
      expect(formatDuration(1 * 86400)).toBe('1d')
      expect(formatDuration(1 * 86400 + 3 * 3600)).toBe('1d')
      expect(formatDuration(89 * 86400 + 12 * 3600 + 45 * 60)).toBe('89d')
    })

    it('returns hours when 1h <= time < 1d, dropping sub-hour remainder', () => {
      expect(formatDuration(1 * 3600)).toBe('1h')
      expect(formatDuration(23 * 3600)).toBe('23h')
      expect(formatDuration(1 * 3600 + 30 * 60)).toBe('1h')
    })

    it('returns minutes when time < 1h', () => {
      expect(formatDuration(30 * 60)).toBe('30m')
      expect(formatDuration(59 * 60)).toBe('59m')
    })

    it('returns 1m minimum for very small positive diffs', () => {
      expect(formatDuration(10)).toBe('1m')
      expect(formatDuration(1)).toBe('1m')
    })

    it('returns null when zero or negative', () => {
      expect(formatDuration(0)).toBeNull()
      expect(formatDuration(-100)).toBeNull()
    })
  })

  describe('long format, coarse', () => {
    it('returns singular day', () => {
      expect(formatDuration(1 * 86400, { format: 'long' })).toBe('1 day')
    })

    it('returns plural days, dropping hours', () => {
      expect(formatDuration(89 * 86400, { format: 'long' })).toBe('89 days')
      expect(formatDuration(2 * 86400 + 3 * 3600, { format: 'long' })).toBe('2 days')
    })

    it('returns singular and plural hours', () => {
      expect(formatDuration(1 * 3600, { format: 'long' })).toBe('1 hour')
      expect(formatDuration(5 * 3600, { format: 'long' })).toBe('5 hours')
    })

    it('returns singular and plural minutes', () => {
      expect(formatDuration(60, { format: 'long' })).toBe('1 minute')
      expect(formatDuration(10, { format: 'long' })).toBe('1 minute')
      expect(formatDuration(30 * 60, { format: 'long' })).toBe('30 minutes')
    })

    it('returns null when zero or negative', () => {
      expect(formatDuration(0, { format: 'long' })).toBeNull()
      expect(formatDuration(-100, { format: 'long' })).toBeNull()
    })
  })

  describe('granular: combines two adjacent units when remainder is non-zero', () => {
    it('short: combines days and hours', () => {
      expect(formatDuration(1 * 86400 + 3 * 3600, { granular: true })).toBe('1d 3h')
      expect(formatDuration(89 * 86400 + 12 * 3600, { granular: true })).toBe('89d 12h')
    })

    it('short: drops sub-hour remainder when >= 1 day', () => {
      expect(formatDuration(1 * 86400 + 45 * 60, { granular: true })).toBe('1d')
      expect(formatDuration(1 * 86400, { granular: true })).toBe('1d')
    })

    it('short: combines hours and minutes when < 1 day', () => {
      expect(formatDuration(1 * 3600 + 30 * 60, { granular: true })).toBe('1h 30m')
      expect(formatDuration(23 * 3600 + 59 * 60, { granular: true })).toBe('23h 59m')
      expect(formatDuration(1 * 3600, { granular: true })).toBe('1h')
    })

    it('short: returns minutes only when < 1h (unchanged by granular)', () => {
      expect(formatDuration(30 * 60, { granular: true })).toBe('30m')
      expect(formatDuration(90, { granular: true })).toBe('1m')
    })

    it('long: combines days and hours with comma separator', () => {
      expect(formatDuration(1 * 86400 + 1 * 3600, { format: 'long', granular: true })).toBe(
        '1 day, 1 hour'
      )
      expect(formatDuration(2 * 86400 + 3 * 3600, { format: 'long', granular: true })).toBe(
        '2 days, 3 hours'
      )
    })

    it('long: combines hours and minutes with comma separator', () => {
      expect(formatDuration(1 * 3600 + 1 * 60, { format: 'long', granular: true })).toBe(
        '1 hour, 1 minute'
      )
      expect(formatDuration(5 * 3600 + 30 * 60, { format: 'long', granular: true })).toBe(
        '5 hours, 30 minutes'
      )
    })

    it('returns null for non-positive inputs', () => {
      expect(formatDuration(0, { granular: true })).toBeNull()
      expect(formatDuration(-100, { format: 'long', granular: true })).toBeNull()
    })
  })
})

describe('dateTimeLabelForUnixTimestamp', () => {
  it('formats with date and time components', () => {
    const timestamp = 1704153600
    const result = dateTimeLabelForUnixTimestamp(timestamp)

    // "Jan 2, 2024, 08:00" — exact time depends on test timezone
    expect(result).toMatch(/\w+ \d+, \d{4}, \d{1,2}:\d{2}( [AP]M)?/)
    expect(result).toContain('2024')
  })

  it('separates date and time with a comma', () => {
    const result = dateTimeLabelForUnixTimestamp(1700000000)
    expect(result.split(', ')).toHaveLength(3)
  })
})

describe('fullUtcDateLabel', () => {
  it('should format a Unix timestamp to full UTC date with time', () => {
    // 2026-09-15 12:34:00 UTC
    const timestamp = 1789475640
    const result = fullUtcDateLabel(timestamp)
    expect(result).toBe('September 15, 2026, 12:34 UTC')
  })

  it('should handle midnight UTC', () => {
    // 2024-01-01 00:00:00 UTC
    const timestamp = 1704067200
    const result = fullUtcDateLabel(timestamp)
    expect(result).toBe('January 1, 2024, 00:00 UTC')
  })

  it('should pad single-digit hours and minutes', () => {
    // 2024-03-05 05:03:00 UTC
    const timestamp = 1709614980
    const result = fullUtcDateLabel(timestamp)
    expect(result).toBe('March 5, 2024, 05:03 UTC')
  })

  it('should handle epoch timestamp', () => {
    const result = fullUtcDateLabel(0)
    expect(result).toBe('January 1, 1970, 00:00 UTC')
  })
})
