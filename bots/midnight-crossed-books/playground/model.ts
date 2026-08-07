import {
  CROSSED_BOOKS_STRATEGY_ENV_KEYS,
  parseCrossedBooksStrategyEnvironment
} from '../src/config/strategy-config'

export type StrategyInput = {
  minimumProfitAssets: string
  maxMatches: string
  scanIntervalMs: string
}
export type PlaygroundState = { strategy: StrategyInput }

export const STRATEGY_FIELDS = [
  ['minimumProfitAssets', 'Minimum profit (assets)', 'MIN_PROFIT_ASSETS', 'Raw loan-token units'],
  ['maxMatches', 'Maximum matches', 'MAX_MATCHES', 'Crossed matches per resolver transaction'],
  ['scanIntervalMs', 'Scan interval (ms)', 'SCAN_INTERVAL_MS', 'Delay between book scans']
] as const

export const createDefaultPlaygroundState = (): PlaygroundState => ({
  strategy: { minimumProfitAssets: '1', maxMatches: '10', scanIntervalMs: '15000' }
})

const MAXIMUM_JSON_BYTES = 128 * 1024
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (record: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(record).some(key => !allowed.includes(key))) {
    throw new Error('Object contains an unsupported key')
  }
  if (Object.keys(record).length !== allowed.length || allowed.some(key => !(key in record))) {
    throw new Error('Object is missing a required key')
  }
}
const parseJson = (text: string): unknown => {
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_JSON_BYTES) {
    throw new Error('JSON exceeds the 128 KiB size limit')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Import must be valid JSON')
  }
}

export const toStrategyEnvironment = (strategy: StrategyInput) => ({
  MIN_PROFIT_ASSETS: strategy.minimumProfitAssets,
  MAX_MATCHES: strategy.maxMatches,
  SCAN_INTERVAL_MS: strategy.scanIntervalMs
})

const parseStrategy = (value: unknown): StrategyInput => {
  if (!plainObject(value)) throw new Error('Strategy configuration must be an object')
  const inputKeys = STRATEGY_FIELDS.map(([key]) => key)
  const environmentKeys = [...CROSSED_BOOKS_STRATEGY_ENV_KEYS]
  const keys = Object.keys(value)
  let strategy: StrategyInput
  if (keys.every(key => inputKeys.includes(key as never))) {
    exactKeys(value, inputKeys)
    strategy = {
      minimumProfitAssets: String(value.minimumProfitAssets),
      maxMatches: String(value.maxMatches),
      scanIntervalMs: String(value.scanIntervalMs)
    }
  } else if (keys.every(key => environmentKeys.includes(key as never))) {
    exactKeys(value, environmentKeys)
    strategy = {
      minimumProfitAssets: String(value.MIN_PROFIT_ASSETS),
      maxMatches: String(value.MAX_MATCHES),
      scanIntervalMs: String(value.SCAN_INTERVAL_MS)
    }
  } else {
    throw new Error('Object contains an unsupported key')
  }
  parseCrossedBooksStrategyEnvironment(toStrategyEnvironment(strategy))
  return strategy
}

/** Accepts pasted JSON only: strategy input/environment objects or one compact JSON string layer. */
export const parseStrategyImport = (text: string): StrategyInput => {
  let value = parseJson(text)
  if (typeof value === 'string') value = parseJson(value)
  if (typeof value === 'string') throw new Error('Import accepts at most one JSON string layer')
  return parseStrategy(value)
}

export const validateStrategy = (strategy: StrategyInput) => {
  try {
    parseStrategy(strategy)
    return { valid: true, errors: [] as string[] }
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid strategy'] }
  }
}

export const exportReadableEnvironmentJson = (strategy: StrategyInput) => {
  parseStrategy(strategy)
  return `${JSON.stringify(toStrategyEnvironment(strategy), null, 2)}\n`
}
export const exportCompactEnvironmentJson = (strategy: StrategyInput) => {
  parseStrategy(strategy)
  return JSON.stringify(toStrategyEnvironment(strategy))
}

export const PLAYGROUND_FRAGMENT_VERSION = 1
export const encodePlaygroundFragment = (state: PlaygroundState) => {
  const strategy = parseStrategy(state.strategy)
  const encoded = encodeURIComponent(
    JSON.stringify({ version: PLAYGROUND_FRAGMENT_VERSION, strategy })
  )
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_JSON_BYTES) {
    throw new Error('Fragment exceeds the 128 KiB size limit')
  }
  return `#${encoded}`
}
export const decodePlaygroundFragment = (fragment: string): PlaygroundState => {
  const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!encoded) return createDefaultPlaygroundState()
  if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_JSON_BYTES) {
    throw new Error('Fragment exceeds the 128 KiB size limit')
  }
  let text: string
  try {
    text = decodeURIComponent(encoded)
  } catch {
    throw new Error('Fragment must be valid percent-encoded JSON')
  }
  const value = parseJson(text)
  if (!plainObject(value)) throw new Error('Fragment payload must be an object')
  exactKeys(value, ['version', 'strategy'])
  if (value.version !== PLAYGROUND_FRAGMENT_VERSION) throw new Error('Unsupported fragment version')
  return { strategy: parseStrategy(value.strategy) }
}
export const createPlaygroundShareUrl = (
  state: PlaygroundState,
  location: Pick<Location, 'origin' | 'pathname' | 'search'>
) => `${location.origin}${location.pathname}${location.search}${encodePlaygroundFragment(state)}`
