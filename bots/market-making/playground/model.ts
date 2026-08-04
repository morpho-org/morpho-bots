export const BOT_ENVIRONMENT_KEYS = [
  'CHAIN_ID',
  'RPC_URL',
  'REFERENCE_RPC_URL',
  'MAKER_PRIVATE_KEY',
  'MAKER_ADDRESS',
  'MIDNIGHT_ADDRESS',
  'LOAN_ASSET_ADDRESS',
  'RATIFIER_ADDRESS',
  'MARKET_IDS',
  'REFERENCE_MARKET_ID',
  'NATIVE_RESERVE_WEI',
  'MAXIMUM_LEND_EXPOSURE_ASSETS',
  'MORPHO_API_BASE_URL',
  'ROUTER_API_BASE_URL',
  'V0_OFFER_GROUP_IDS',
  'REQUEST_TIMEOUT_MS',
  'TRANSACTION_RECEIPT_TIMEOUT_MS',
  'BOOTSTRAP_MARKETS',
  'LADDER_MARKETS',
  'BETTERSTACK_SOURCE_TOKEN',
  'BETTERSTACK_INGESTING_HOST',
  'BETTERSTACK_HEARTBEAT_URL'
] as const

export const SCALAR_FIELDS = [
  ['CHAIN_ID', 'Chain ID', 'Base only (8453)', 'number'],
  ['RPC_URL', 'Current-state RPC URL', 'Base JSON-RPC endpoint', 'url'],
  ['REFERENCE_RPC_URL', 'Archive RPC URL', 'Historical reference reads', 'url'],
  [
    'MAKER_PRIVATE_KEY',
    'Maker private key',
    'Prefer environment secrets; omit in read-only mode',
    'password'
  ],
  ['MAKER_ADDRESS', 'Maker address', 'Balance, allowance, offers, and exposure owner', 'text'],
  ['MIDNIGHT_ADDRESS', 'Midnight address', 'Expected singleton contract', 'text'],
  ['LOAN_ASSET_ADDRESS', 'Loan asset address', 'Asset used by every configured market', 'text'],
  ['RATIFIER_ADDRESS', 'Ratifier address', 'Router-listed Ecrecover ratifier', 'text'],
  ['MARKET_IDS', 'Market IDs', 'Comma-separated bytes32 allowlist', 'text'],
  ['REFERENCE_MARKET_ID', 'Reference market ID', 'Morpho Blue variable-rate market', 'text'],
  ['NATIVE_RESERVE_WEI', 'Native reserve (wei)', 'Required gas reserve', 'number'],
  [
    'MAXIMUM_LEND_EXPOSURE_ASSETS',
    'Maximum lend exposure (assets)',
    'Required Midnight allowance floor',
    'number'
  ],
  ['MORPHO_API_BASE_URL', 'Morpho API base URL', 'Books and maker offer groups', 'url'],
  ['ROUTER_API_BASE_URL', 'Router API base URL', 'Ratifier registry', 'url'],
  [
    'V0_OFFER_GROUP_IDS',
    'V0 offer group IDs',
    'Optional comma-separated adopted group IDs',
    'text'
  ],
  ['REQUEST_TIMEOUT_MS', 'Request timeout (ms)', '1–120000; defaults to 10000', 'number'],
  [
    'TRANSACTION_RECEIPT_TIMEOUT_MS',
    'Receipt timeout (ms)',
    '1–900000; defaults to 180000',
    'number'
  ]
] as const

export const BOOTSTRAP_FIELDS = [
  ['marketId', 'Market ID', 'Allowlisted bytes32 market', 'text'],
  ['creditTarget', 'Credit target', 'Positive raw credit units', 'number'],
  ['acceptanceAssets', 'Acceptance assets', 'Allowed target shortfall', 'number'],
  ['offerSize', 'Offer size', 'Desired raw offer size', 'number'],
  ['premiumBps', 'Premium (BPS)', 'Zero or negative', 'number'],
  ['maximumMarketExposure', 'Maximum market exposure', 'Raw per-market cap', 'number'],
  ['maximumTotalExposure', 'Maximum total exposure', 'Raw strategy-wide cap', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive final-rate floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive final-rate ceiling', 'number'],
  ['autoRefill', 'Auto-refill', 'Resume after observed completion', 'checkbox']
] as const

export const LADDER_FIELDS = [
  ['marketId', 'Market ID', 'Allowlisted bytes32 market', 'text'],
  ['quotePremiumBps', 'Quote premium (BPS)', 'Signed center offset', 'number'],
  ['spreadBps', 'Full spread (BPS)', 'Positive even distance between nearest rungs', 'number'],
  ['stepBps', 'Step (BPS)', 'Distance between same-side rungs', 'number'],
  ['rungCount', 'Rungs per side', '1–512', 'number'],
  ['sizeSkewBps', 'Size skew (BPS)', 'Signed outer-rung weight change', 'number'],
  ['lowerRateBudgetAssets', 'Lower-rate budget', 'Raw reduce-only sell budget', 'number'],
  ['higherRateBudgetAssets', 'Higher-rate budget', 'Raw lend-buy budget', 'number'],
  ['targetMarketExposureAssets', 'Target market exposure', 'Raw market cap', 'number'],
  ['maximumTotalExposureAssets', 'Maximum total exposure', 'Raw strategy-wide cap', 'number'],
  ['minimumOfferAssets', 'Minimum offer assets', 'Smallest emitted rung', 'number'],
  ['groupMode', 'Group mode', 'shared-rung or per-book', 'select'],
  ['loopIntervalSeconds', 'Loop interval (seconds)', 'Monitor cadence', 'number'],
  ['movementToleranceBps', 'Movement tolerance (BPS)', 'Inclusive recenter deadband', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive hard floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive hard ceiling', 'number']
] as const

export const OBSERVABILITY_FIELDS = [
  [
    'BETTERSTACK_SOURCE_TOKEN',
    'Better Stack source token',
    'Optional; pair with ingest host',
    'password'
  ],
  [
    'BETTERSTACK_INGESTING_HOST',
    'Better Stack ingest host',
    'Optional; pair with source token',
    'text'
  ],
  [
    'BETTERSTACK_HEARTBEAT_URL',
    'Better Stack heartbeat URL',
    'Optional best-effort heartbeat',
    'url'
  ]
] as const

type ScalarKey = (typeof SCALAR_FIELDS)[number][0]
type BootstrapKey = (typeof BOOTSTRAP_FIELDS)[number][0]
type LadderKey = (typeof LADDER_FIELDS)[number][0]
type ObservabilityKey = (typeof OBSERVABILITY_FIELDS)[number][0]

export type PlaygroundState = {
  scalar: Record<ScalarKey, string>
  bootstrap: Record<Exclude<BootstrapKey, 'autoRefill'>, string> & { autoRefill: boolean }
  ladder: Record<LadderKey, string>
  observability: Record<ObservabilityKey, string>
  referenceRateBps: string
}

const marketId = `0x${'5'.repeat(64)}`
const referenceMarketId = `0x${'7'.repeat(64)}`
const offerGroupId = `0x${'8'.repeat(64)}`

export const createDefaultPlaygroundState = (): PlaygroundState => ({
  scalar: {
    CHAIN_ID: '8453',
    RPC_URL: 'https://base-rpc.example',
    REFERENCE_RPC_URL: 'https://base-archive-rpc.example',
    MAKER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
    MAKER_ADDRESS: `0x${'1'.repeat(40)}`,
    MIDNIGHT_ADDRESS: `0x${'2'.repeat(40)}`,
    LOAN_ASSET_ADDRESS: `0x${'3'.repeat(40)}`,
    RATIFIER_ADDRESS: `0x${'4'.repeat(40)}`,
    MARKET_IDS: marketId,
    REFERENCE_MARKET_ID: referenceMarketId,
    NATIVE_RESERVE_WEI: '10000000000000000',
    MAXIMUM_LEND_EXPOSURE_ASSETS: '10000000000',
    MORPHO_API_BASE_URL: 'https://api.example',
    ROUTER_API_BASE_URL: 'https://router.example',
    V0_OFFER_GROUP_IDS: offerGroupId,
    REQUEST_TIMEOUT_MS: '10000',
    TRANSACTION_RECEIPT_TIMEOUT_MS: '180000'
  },
  bootstrap: {
    marketId,
    creditTarget: '10000000000',
    acceptanceAssets: '100000000',
    offerSize: '500000000',
    premiumBps: '-50',
    maximumMarketExposure: '20000000000',
    maximumTotalExposure: '30000000000',
    minimumRateBps: '200',
    maximumRateBps: '800',
    autoRefill: false
  },
  ladder: {
    marketId,
    quotePremiumBps: '0',
    spreadBps: '200',
    stepBps: '100',
    rungCount: '3',
    sizeSkewBps: '0',
    lowerRateBudgetAssets: '10000000000',
    higherRateBudgetAssets: '10000000000',
    targetMarketExposureAssets: '20000000000',
    maximumTotalExposureAssets: '30000000000',
    minimumOfferAssets: '101000000',
    groupMode: 'shared-rung',
    loopIntervalSeconds: '60',
    movementToleranceBps: '10',
    minimumRateBps: '200',
    maximumRateBps: '800'
  },
  observability: {
    BETTERSTACK_SOURCE_TOKEN: '',
    BETTERSTACK_INGESTING_HOST: '',
    BETTERSTACK_HEARTBEAT_URL: ''
  },
  referenceRateBps: '500'
})

const integer = (value: string, name: string) => {
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be a decimal integer`)
  return BigInt(value)
}

const allocate = (budget: bigint, count: number, skew: bigint, floor: bigint) => {
  const weights = Array.from({ length: count }, (_, index) => 10_000n + BigInt(index) * skew)
  if (weights.some(weight => weight <= 0n)) throw new Error('Every rung weight must stay positive')
  const fundedCount = Math.min(count, Number(budget / floor))
  if (fundedCount === 0) return []
  const fundedWeights = weights.slice(0, fundedCount)
  const remainderBudget = budget - floor * BigInt(fundedCount)
  const totalWeight = fundedWeights.reduce((sum, weight) => sum + weight, 0n)
  const amounts = fundedWeights.map(weight => floor + (remainderBudget * weight) / totalWeight)
  const allocated = amounts.reduce((sum, amount) => sum + amount, 0n)
  amounts[amounts.length - 1] = (amounts.at(-1) ?? 0n) + budget - allocated
  return amounts
}

export type PreviewRung = { index: number; rateBps: string; assets: string }

export const generatePreviewLadder = (state: PlaygroundState) => {
  const ladder = state.ladder
  const count = Number(integer(ladder.rungCount, 'rungCount'))
  if (!Number.isSafeInteger(count) || count < 1 || count > 512) {
    throw new Error('rungCount must be between 1 and 512')
  }
  const spread = integer(ladder.spreadBps, 'spreadBps')
  if (spread <= 0n || spread % 2n !== 0n) throw new Error('spreadBps must be positive and even')
  const step = integer(ladder.stepBps, 'stepBps')
  const center =
    integer(state.referenceRateBps, 'referenceRateBps') +
    integer(ladder.quotePremiumBps, 'quotePremiumBps')
  const floor = integer(ladder.minimumOfferAssets, 'minimumOfferAssets')
  const skew = integer(ladder.sizeSkewBps, 'sizeSkewBps')
  const lowerAmounts = allocate(
    integer(ladder.lowerRateBudgetAssets, 'lowerRateBudgetAssets'),
    count,
    skew,
    floor
  )
  const higherAmounts = allocate(
    integer(ladder.higherRateBudgetAssets, 'higherRateBudgetAssets'),
    count,
    skew,
    floor
  )
  const halfSpread = spread / 2n
  const rungs = (side: 'lower' | 'higher', amounts: readonly bigint[]): PreviewRung[] =>
    amounts.map((assets, index) => {
      const offset = halfSpread + BigInt(index) * step
      const rate = side === 'lower' ? center - offset : center + offset
      return { index, rateBps: String(rate), assets: String(assets) }
    })
  return {
    centerRateBps: String(center),
    lower: rungs('lower', lowerAmounts),
    higher: rungs('higher', higherAmounts)
  }
}

const bootstrapObject = (state: PlaygroundState) => ({ ...state.bootstrap })
const ladderObject = (state: PlaygroundState) => ({ ...state.ladder })
const list = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

export const exportYaml = (state: PlaygroundState) => {
  const scalar = state.scalar
  const lines = [
    'chain:',
    `  id: ${scalar.CHAIN_ID}`,
    `  rpcUrl: ${quote(scalar.RPC_URL)}`,
    `  archiveRpcUrl: ${quote(scalar.REFERENCE_RPC_URL)}`,
    'identity:',
    `  makerAddress: ${quote(scalar.MAKER_ADDRESS)}`,
    `  makerPrivateKey: ${quote(scalar.MAKER_PRIVATE_KEY)}`,
    'contracts:',
    `  midnightAddress: ${quote(scalar.MIDNIGHT_ADDRESS)}`,
    `  loanAssetAddress: ${quote(scalar.LOAN_ASSET_ADDRESS)}`,
    `  ratifierAddress: ${quote(scalar.RATIFIER_ADDRESS)}`,
    'apis:',
    `  morphoBaseUrl: ${quote(scalar.MORPHO_API_BASE_URL)}`,
    `  routerBaseUrl: ${quote(scalar.ROUTER_API_BASE_URL)}`,
    'markets:',
    '  allowlist:',
    ...list(scalar.MARKET_IDS).map(value => `    - ${quote(value)}`),
    `  referenceMarketId: ${quote(scalar.REFERENCE_MARKET_ID)}`,
    '  v0OfferGroupIds:',
    ...list(scalar.V0_OFFER_GROUP_IDS).map(value => `    - ${quote(value)}`),
    'setup:',
    `  nativeReserveWei: ${quote(scalar.NATIVE_RESERVE_WEI)}`,
    `  maximumLendExposureAssets: ${quote(scalar.MAXIMUM_LEND_EXPOSURE_ASSETS)}`,
    `  requestTimeoutMs: ${scalar.REQUEST_TIMEOUT_MS}`,
    `  transactionReceiptTimeoutMs: ${scalar.TRANSACTION_RECEIPT_TIMEOUT_MS}`,
    'bootstrap:'
  ]
  for (const [index, [key]] of BOOTSTRAP_FIELDS.entries()) {
    const value = state.bootstrap[key]
    const prefix = index === 0 ? '  - ' : '    '
    lines.push(`${prefix}${key}: ${typeof value === 'boolean' ? value : quote(value)}`)
  }
  lines.push('ladder:')
  for (const [index, [key]] of LADDER_FIELDS.entries()) {
    const prefix = index === 0 ? '  - ' : '    '
    lines.push(`${prefix}${key}: ${quote(state.ladder[key])}`)
  }
  return `${lines.join('\n')}\n`
}

export const exportEnvironment = (state: PlaygroundState) => {
  const structured = {
    BOOTSTRAP_MARKETS: JSON.stringify([bootstrapObject(state)]),
    LADDER_MARKETS: JSON.stringify([ladderObject(state)])
  }
  return `${[
    ...SCALAR_FIELDS.map(([key]) => `${key}=${state.scalar[key]}`),
    `BOOTSTRAP_MARKETS=${structured.BOOTSTRAP_MARKETS}`,
    `LADDER_MARKETS=${structured.LADDER_MARKETS}`,
    ...OBSERVABILITY_FIELDS.map(([key]) => `${key}=${state.observability[key]}`)
  ].join('\n')}\n`
}

export const exportJson = (state: PlaygroundState) =>
  `${JSON.stringify(
    {
      configuration: {
        ...state.scalar,
        BOOTSTRAP_MARKETS: [bootstrapObject(state)],
        LADDER_MARKETS: [ladderObject(state)]
      },
      observability: state.observability
    },
    null,
    2
  )}\n`
