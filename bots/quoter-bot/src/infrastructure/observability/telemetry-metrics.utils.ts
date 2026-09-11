import type { Attributes } from '@opentelemetry/api'

import { metrics } from '@opentelemetry/api'

import type { MonitoringEvent } from '../../application/monitoring/monitoring-event'

type SubmittedTransactionRecord = {
  event: `${string}.transaction-submitted`
  operation?: unknown
  marketId?: unknown
  txHash?: unknown
}

type BookRateField = 'bestRateBps' | 'worstRateBps' | 'centerRateBps'

const SUBMITTED_TX_MEMORY = 256

const asNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

const definedAttributes = (attributes: Record<string, unknown>): Attributes => {
  const entries = Object.entries(attributes).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'
  )
  return Object.fromEntries(entries)
}

/**
 * Derives OpenTelemetry metrics from the bot's shipped monitoring-record stream.
 * @returns A record observer mirroring sanitized records into counters, histograms, and gauges.
 * @remarks Instruments bind to the global meter provider at creation, so call this after the
 * telemetry pipeline has registered. Metric attributes are restricted to the grouping dimensions
 * the monitoring-event contract allows plus the derived `type` and `phase` discriminators —
 * `txHash`, `groupId`, and `errorName` never become attributes. `*_assets` and `*_bps` values are
 * raw smallest-unit integers converted to floating point, so magnitudes beyond 2^53 lose
 * precision but keep scale. Book rate gauges are observable and mirror only the latest record
 * per market and side, so an empty book stops exporting rates rather than freezing stale ones.
 * Observation never throws: a malformed record is dropped, because telemetry must not interrupt
 * quoting.
 */
export const createTelemetryRecordObserver = () => {
  const meter = metrics.getMeter('quoter-bot')
  const cycles = meter.createCounter('quoter_bot.cycles', {
    description: 'Completed monitor cycle results by workflow and status.'
  })
  const cycleDuration = meter.createHistogram('quoter_bot.cycle.duration', {
    unit: 'ms',
    description: 'Duration of completed monitor cycle results.'
  })
  const failures = meter.createCounter('quoter_bot.failures', {
    description: 'Terminal bot failures by workflow and reason.'
  })
  const guardrails = meter.createCounter('quoter_bot.guardrail.events', {
    description: 'Guardrail interventions by type.'
  })
  const transactions = meter.createCounter('quoter_bot.transactions', {
    description: 'Submitted and settled transactions by workflow and operation.'
  })
  const offersConsumed = meter.createCounter('quoter_bot.offers.consumed', {
    description: 'Observed taker fills of bot-owned offer groups.'
  })
  const offersConsumedAssets = meter.createCounter('quoter_bot.offers.consumed_assets', {
    description: 'Raw loan-asset amount filled from bot-owned offer groups.'
  })
  const setupChecks = meter.createCounter('quoter_bot.setup.checks', {
    description: 'Failed and warning setup checks by check name.'
  })
  const gauge = (name: string, description: string, unit?: string) =>
    meter.createGauge(name, { description, ...(unit === undefined ? {} : { unit }) })
  const referenceRate = gauge(
    'quoter_bot.reference.rate_bps',
    'Observed reference rate in basis points.'
  )
  const targetRate = gauge(
    'quoter_bot.reference.target_rate_bps',
    'Derived target rate in basis points.'
  )
  const positionGauges = {
    cashBalanceAssets: gauge('quoter_bot.position.cash_balance_assets', 'Maker cash balance.'),
    creditAssets: gauge('quoter_bot.position.credit_assets', 'Maker credit in the market.'),
    otherMarketCreditAssets: gauge(
      'quoter_bot.position.other_market_credit_assets',
      'Maker credit held in other markets.'
    ),
    reservedAssets: gauge('quoter_bot.position.reserved_assets', 'Maker reserved assets.'),
    marketReservedAssets: gauge(
      'quoter_bot.position.market_reserved_assets',
      'Maker reserved assets in the market.'
    ),
    maturityTimestamp: gauge(
      'quoter_bot.position.maturity_timestamp_seconds',
      'Market maturity timestamp.',
      's'
    ),
    lowerRateCapacityAssets: gauge(
      'quoter_bot.position.lower_rate_capacity_assets',
      'Remaining lower-rate quoting capacity.'
    ),
    higherRateCapacityAssets: gauge(
      'quoter_bot.position.higher_rate_capacity_assets',
      'Remaining higher-rate quoting capacity.'
    ),
    targetMarketCapacityAssets: gauge(
      'quoter_bot.position.target_market_capacity_assets',
      'Remaining per-market exposure capacity.'
    ),
    maximumTotalCapacityAssets: gauge(
      'quoter_bot.position.maximum_total_capacity_assets',
      'Remaining total exposure capacity.'
    )
  }
  const bootstrapCredit = gauge('quoter_bot.bootstrap.credit_assets', 'Bootstrap credit progress.')
  const bootstrapCreditTarget = gauge(
    'quoter_bot.bootstrap.credit_target_assets',
    'Bootstrap credit target.'
  )
  const bookGauges = {
    rungs: gauge('quoter_bot.book.rungs', 'Published rungs on one book side.'),
    totalAssets: gauge('quoter_bot.book.total_assets', 'Published assets on one book side.'),
    quoting: gauge('quoter_bot.book.quoting', 'Whether one book side is actively quoting (0/1).')
  }
  // Rates exist only while a side quotes, and a synchronous gauge keeps exporting its last value
  // after the book empties — a stale rate beside quoting=0. Each book.observed replaces the
  // side's registry entry with exactly the rates it carries, so an empty book drops its rate
  // data points instead of freezing them.
  const bookRates = new Map<
    string,
    { attributes: Attributes; rates: Record<BookRateField, number | undefined> }
  >()
  const bookRateGauge = (name: string, description: string, field: BookRateField) =>
    meter.createObservableGauge(name, { description }).addCallback(result => {
      for (const { attributes, rates } of bookRates.values()) {
        const value = rates[field]
        if (value !== undefined) result.observe(value, attributes)
      }
    })
  bookRateGauge(
    'quoter_bot.book.best_rate_bps',
    'Best published rate on one quoting book side.',
    'bestRateBps'
  )
  bookRateGauge(
    'quoter_bot.book.worst_rate_bps',
    'Worst published rate on one quoting book side.',
    'worstRateBps'
  )
  bookRateGauge(
    'quoter_bot.book.center_rate_bps',
    'Ladder center rate on one quoting book side.',
    'centerRateBps'
  )

  // Batched invalidation emits one submitted record per group sharing a single transaction hash,
  // so submitted-phase increments deduplicate on a bounded memory of recent hashes.
  const recentSubmittedTxHashes = new Set<string>()
  const isFirstSubmission = (txHash: unknown) => {
    if (typeof txHash !== 'string') return true
    if (recentSubmittedTxHashes.has(txHash)) return false
    recentSubmittedTxHashes.add(txHash)
    if (recentSubmittedTxHashes.size > SUBMITTED_TX_MEMORY) {
      const oldest = recentSubmittedTxHashes.values().next().value
      if (oldest !== undefined) recentSubmittedTxHashes.delete(oldest)
    }
    return true
  }

  const observe = (record: MonitoringEvent | SubmittedTransactionRecord) => {
    if (record.event.endsWith('.transaction-submitted')) {
      const submitted = record as SubmittedTransactionRecord
      if (!isFirstSubmission(submitted.txHash)) return
      transactions.add(
        1,
        definedAttributes({
          phase: 'submitted',
          workflow: submitted.event.split('.', 1)[0],
          operation: submitted.operation,
          marketId: submitted.marketId
        })
      )
      return
    }
    const event = record as MonitoringEvent
    switch (event.event) {
      case 'cycle.completed': {
        const attributes = definedAttributes({
          workflow: event.workflow,
          status: event.status,
          marketId: event.marketId,
          stage: event.stage,
          action: event.action,
          reason: event.reason
        })
        cycles.add(1, attributes)
        const durationMs = asNumber(event.durationMs)
        if (durationMs !== undefined) {
          cycleDuration.record(
            durationMs,
            definedAttributes({
              workflow: event.workflow,
              status: event.status,
              marketId: event.marketId
            })
          )
        }
        return
      }
      case 'bot.failed':
        failures.add(1, definedAttributes({ workflow: event.workflow, reason: event.reason }))
        return
      case 'guardrail.rate-clamped':
      case 'guardrail.cross-book-cleared':
      case 'guardrail.book-cleared':
      case 'guardrail.book-crossed':
      case 'guardrail.exposure-capped':
      case 'guardrail.rungs-truncated':
      case 'guardrail.spread-rejected':
      case 'guardrail.halted': {
        const fields = event as Record<string, unknown> & { event: string }
        guardrails.add(
          1,
          definedAttributes({
            type: event.event.slice('guardrail.'.length),
            workflow: fields.workflow,
            marketId: fields.marketId,
            side: fields.side,
            stage: fields.stage,
            reason: fields.reason,
            bound: fields.bound,
            cap: fields.cap,
            clearable: fields.clearable,
            suppressed: fields.suppressed
          })
        )
        return
      }
      case 'reference.observed': {
        const attributes = { workflow: event.workflow, marketId: event.marketId }
        const rate = asNumber(event.referenceRateBps)
        if (rate !== undefined) referenceRate.record(rate, attributes)
        const target = asNumber(event.targetRateBps)
        if (target !== undefined) targetRate.record(target, attributes)
        return
      }
      case 'position.observed': {
        const attributes = { marketId: event.marketId }
        for (const [field, instrument] of Object.entries(positionGauges)) {
          const value = asNumber(event[field as keyof typeof event])
          if (value !== undefined) instrument.record(value, attributes)
        }
        return
      }
      case 'bootstrap.progress': {
        const attributes = { marketId: event.marketId }
        const credit = asNumber(event.creditAssets)
        if (credit !== undefined) bootstrapCredit.record(credit, attributes)
        const creditTarget = asNumber(event.creditTargetAssets)
        if (creditTarget !== undefined) bootstrapCreditTarget.record(creditTarget, attributes)
        return
      }
      case 'book.observed': {
        const attributes = { marketId: event.marketId, side: event.side }
        bookGauges.rungs.record(event.rungs, attributes)
        bookGauges.quoting.record(event.state === 'quoting' ? 1 : 0, attributes)
        const totalAssets = asNumber(event.totalAssets)
        if (totalAssets !== undefined) bookGauges.totalAssets.record(totalAssets, attributes)
        bookRates.set(`${event.marketId}|${event.side}`, {
          attributes,
          rates: {
            bestRateBps: asNumber(event.bestRateBps),
            worstRateBps: asNumber(event.worstRateBps),
            centerRateBps: asNumber(event.centerRateBps)
          }
        })
        return
      }
      case 'offer.consumed': {
        const attributes = { marketId: event.marketId, side: event.side }
        offersConsumed.add(1, attributes)
        const consumed = asNumber(event.consumedDeltaAssets)
        if (consumed !== undefined && consumed >= 0) offersConsumedAssets.add(consumed, attributes)
        return
      }
      case 'transaction.settled':
        transactions.add(
          1,
          definedAttributes({
            phase: 'settled',
            workflow: event.workflow,
            operation: event.operation,
            marketId: event.marketId
          })
        )
        return
      case 'setup.check-failed':
      case 'setup.check-warning':
        setupChecks.add(1, { check: event.check, status: event.status })
        return
      // Static configuration echoes; the log stream carries them and no aggregation needs them.
      case 'bot.configured':
      case 'market.configured':
        return
      default:
        return
    }
  }

  return {
    /**
     * Mirrors one already-shipped monitoring record into OpenTelemetry instruments.
     * @param value - Sanitized record from the shipping allowlist; anything else is ignored.
     * @remarks Never throws and never mutates the record.
     */
    record(value: unknown) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const event = (value as { event?: unknown }).event
      if (typeof event !== 'string') return
      try {
        observe(value as MonitoringEvent | SubmittedTransactionRecord)
      } catch {
        return
      }
    }
  }
}
