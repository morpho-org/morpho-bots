import { ZonedDateTime } from '@internationalized/date';
import { format } from 'date-fns';
import isNil from 'lodash-es/isNil';

export const oneSecondInMs = 1000;
export const oneMinInMs = 60 * oneSecondInMs;
export const oneHourInMs = 60 * oneMinInMs;
export const oneDayInMs = 24 * oneHourInMs;
export const oneWeekInMs = 7 * oneDayInMs;

export const oneSecond = 1;
export const oneMinInSecs = 60 * oneSecond;
export const oneHourInSecs = 60 * oneMinInSecs;
export const oneDayInSecs = 24 * oneHourInSecs;

export const twentyFourHoursInMs = 24 * oneHourInMs;
export const twentyFourHoursInSecs = twentyFourHoursInMs / oneSecondInMs;

export const oneYearInSecs = twentyFourHoursInSecs * 365;
export const oneWeekInSecs = twentyFourHoursInSecs * 7;

/**
 * Converts hours to seconds
 * @param {number} hrs - Number of hours
 * @returns {Object} Object with conversion method toSecs()
 */
export function hours(hrs: number) {
  return {
    toSecs: () => hrs * oneHourInSecs
  };
}

/**
 * Converts days to seconds or milliseconds
 * @param {number} _days - Number of days
 * @returns {Object} Object with conversion methods toSecs() and toMs()
 */
export function days(_days: number) {
  return {
    toSecs: () => _days * oneDayInSecs,
    toMs: () => _days * oneDayInMs
  };
}

/**
 * Converts minutes to seconds or milliseconds
 * @param {number} _mins - Number of minutes
 * @returns {Object} Object with conversion methods toSecs() and toMs()
 */
export function mins(_mins: number) {
  return {
    toSecs: () => _mins * oneMinInSecs,
    toMs: () => _mins * oneMinInMs
  };
}

/**
 * Converts seconds to milliseconds
 * @param {number} _secs - Number of seconds
 * @returns {Object} Object with conversion method toMs()
 */
export function secs(_secs: number) {
  return {
    toMs: () => _secs * oneSecondInMs
  };
}

/**
 * Converts milliseconds to seconds
 * @param {number} _ms - Number of milliseconds
 * @returns {Object} Object with conversion method toSecs()
 */
export function ms(_ms: number) {
  return {
    toSecs: () => _ms / oneSecondInMs
  };
}

/**
 * Converts a Unix timestamp (seconds) to JavaScript timestamp (milliseconds)
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {number} JavaScript timestamp in milliseconds
 */
export function toJsTimestamp(unixTimestamp: number): number {
  return unixTimestamp * oneSecondInMs;
}

/**
 * Converts a JavaScript timestamp (milliseconds) to Unix timestamp (seconds)
 * @param {number} jsTimestamp - JavaScript timestamp in milliseconds
 * @returns {number} Unix timestamp in seconds
 */
export function toUnixTimestamp(jsTimestamp: number): number {
  return Math.round(jsTimestamp / oneSecondInMs);
}

/**
 * Returns the current Unix timestamp in seconds.
 * @returns {number} Current time as a Unix timestamp (seconds since epoch)
 */
export function nowInSeconds(): number {
  return Math.floor(Date.now() / oneSecondInMs);
}

/**
 * Converts a the given string (format 2022-03-30) into a UNIX timestamp
 *
 * @param {string} date - Date string in format 2022-03-30
 * @returns {number} - Unix timestamp in seconds
 */
export function dateToUnixTimestamp(date: string): number {
  return Date.parse(date) / oneSecondInMs;
}

export function formatSecondsToUtcDate(
  timelockDurationSeconds: number | string | undefined
): string {
  if (isNil(timelockDurationSeconds)) {
    return 'N/A';
  }

  const duration =
    typeof timelockDurationSeconds === 'string'
      ? parseInt(timelockDurationSeconds)
      : timelockDurationSeconds;

  if (!isFinite(duration) || duration <= 0) {
    return 'N/A';
  }

  const currentTimeSeconds = nowInSeconds();
  const executionTimeSeconds = currentTimeSeconds + duration;

  const executionDate = new Date(executionTimeSeconds * 1000);

  const utcDate = new Date(
    executionDate.getUTCFullYear(),
    executionDate.getUTCMonth(),
    executionDate.getUTCDate(),
    executionDate.getUTCHours(),
    executionDate.getUTCMinutes(),
    executionDate.getUTCSeconds()
  );

  return format(utcDate, "MMM d, yyyy 'at' h:mm a 'UTC'");
}

/**
 * Converts a Unix timestamp (seconds) to a ZonedDateTime object
 * @param {string} timestamp - Unix timestamp in seconds
 * @returns {ZonedDateTime} ZonedDateTime object
 */
export function secondsToZonedDateTime(timestamp: string): ZonedDateTime {
  const jsDate = new Date(Number(timestamp) * 1000);
  return new ZonedDateTime(
    jsDate.getUTCFullYear(),
    jsDate.getUTCMonth() + 1,
    jsDate.getUTCDate(),
    'Etc/UTC',
    0,
    jsDate.getUTCHours(),
    jsDate.getUTCMinutes(),
    jsDate.getUTCSeconds(),
    jsDate.getUTCMilliseconds()
  );
}

interface FormatDurationOptions {
  /** Unit format. `'short'` → `"5h"`, `'long'` → `"5 hours"`. Defaults to `'short'`. */
  format?: 'short' | 'long';
  /** When true, also show the next-smaller unit if non-zero (e.g. `"5d 3h"` vs `"5d"`). Defaults to false. */
  granular?: boolean;
}

function formatUnit(n: number, unit: 'day' | 'hour' | 'minute', format: 'short' | 'long'): string {
  if (format === 'short') {
    const abbr = unit === 'day' ? 'd' : unit === 'hour' ? 'h' : 'm';
    return `${n}${abbr}`;
  }
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

/**
 * Formats a duration in seconds as a human-readable string.
 *
 * By default, renders the largest unit only in short form (e.g. `"3d"`, `"5h"`).
 * Pass `{ format: 'long' }` for full words (e.g. `"3 days"`). Pass
 * `{ granular: true }` to also include the next-smaller unit when non-zero
 * (e.g. `"3d 12h"`, `"5 hours, 30 minutes"`).
 *
 * Returns `null` for non-positive input. Floors positive sub-minute values to `"1m"`.
 */
export function formatDuration(
  seconds: number,
  { format = 'short', granular = false }: FormatDurationOptions = {}
): string | null {
  if (seconds <= 0) {
    return null;
  }

  const sep = format === 'short' ? ' ' : ', ';

  if (seconds >= oneDayInSecs) {
    const d = Math.floor(seconds / oneDayInSecs);
    if (!granular) {
      return formatUnit(d, 'day', format);
    }
    const h = Math.floor((seconds % oneDayInSecs) / oneHourInSecs);
    const parts = [formatUnit(d, 'day', format)];
    if (h > 0) {
      parts.push(formatUnit(h, 'hour', format));
    }
    return parts.join(sep);
  }
  if (seconds >= oneHourInSecs) {
    const h = Math.floor(seconds / oneHourInSecs);
    if (!granular) {
      return formatUnit(h, 'hour', format);
    }
    const m = Math.floor((seconds % oneHourInSecs) / oneMinInSecs);
    const parts = [formatUnit(h, 'hour', format)];
    if (m > 0) {
      parts.push(formatUnit(m, 'minute', format));
    }
    return parts.join(sep);
  }
  const m = Math.max(1, Math.floor(seconds / oneMinInSecs));
  return formatUnit(m, 'minute', format);
}

export function dateLabelForUnixTimestamp(timestamp: number): string {
  return new Date(toJsTimestamp(timestamp)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Formats a Unix timestamp as a local date and time, e.g. "Apr 30, 2026, 14:30".
 * Use this when the exact moment matters; pair with `DateTimePopover` to show
 * the timezone breakdown on hover.
 */
export function dateTimeLabelForUnixTimestamp(timestamp: number): string {
  const date = new Date(toJsTimestamp(timestamp));
  const datePart = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${datePart}, ${timePart}`;
}

export function fullUtcDateLabel(timestamp: number): string {
  const date = new Date(toJsTimestamp(timestamp));
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${year}, ${hours}:${minutes} UTC`;
}
