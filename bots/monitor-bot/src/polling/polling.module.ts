import type { Logger } from '@repo/bot-kit'

import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import type { AlertDispatcher } from '../alerts/alert'
import type { MonitorEnv } from '../config/env'
import type { CursorStore } from '../cursor/cursor.store'
import type { MidnightEventType } from '../midnight/client'

import { ALERT_DISPATCHER, LogAlertDispatcher } from '../alerts/alert'
import { SlackDispatcher } from '../alerts/slack.dispatcher'
import { ENV } from '../config/env'
import { CURSOR_STORE, InMemoryCursorStore } from '../cursor/cursor.store'
import { LOGGER } from '../logging/logger.provider'
import { createMidnightClient } from '../midnight/client'
import { MarketDirectory } from '../midnight/markets'
import { TransactionFilter } from '../pollers/filter'
import { MarketTransactionsPoller } from '../pollers/market-transactions.poller'
import { OfferGroupsPoller } from '../pollers/offer-groups.poller'
import { POLLERS } from './poller'
import { PollerRegistrar } from './poller.registrar'

function pollerDefinitions(env: MonitorEnv) {
  const repays: MidnightEventType[] = env.REPAYS_INCLUDE_SECONDARY
    ? ['exit_borrow_primary', 'exit_borrow_secondary']
    : ['exit_borrow_primary']
  const collateral: MidnightEventType[] = env.COLLATERAL_INCLUDE_WITHDRAW
    ? ['supply_collateral', 'withdraw_collateral']
    : ['supply_collateral']
  return [
    {
      id: 'take-orders',
      cron: env.POLL_CRON_TAKE_ORDERS,
      eventTypes: ['lend', 'borrow'] as MidnightEventType[]
    },
    { id: 'repays', cron: env.POLL_CRON_REPAYS, eventTypes: repays },
    { id: 'collateral', cron: env.POLL_CRON_COLLATERAL, eventTypes: collateral },
    {
      id: 'liquidations',
      cron: env.POLL_CRON_LIQUIDATIONS,
      eventTypes: ['partial_liquidation', 'full_liquidation'] as MidnightEventType[]
    }
  ]
}

function buildPollers(
  env: MonitorEnv,
  logger: Logger,
  cursors: CursorStore,
  dispatcher: AlertDispatcher
) {
  const client = createMidnightClient(env.MIDNIGHT_API_URL)
  const directory = new MarketDirectory({
    client,
    logger,
    fixedMarketIds: env.MARKET_IDS,
    refreshMs: env.MARKETS_REFRESH_MS
  })
  const filter = new TransactionFilter({
    minAssets: env.FILTER_MIN_ASSETS,
    users: env.FILTER_USERS
  })
  const deps = { cursors, dispatcher, logger, client, directory, filter }
  const pollers: (MarketTransactionsPoller | OfferGroupsPoller)[] = pollerDefinitions(env).map(
    options => new MarketTransactionsPoller(options, deps)
  )
  // Make orders have no protocol-wide feed — the poller only exists when makers are configured.
  if (env.WATCH_MAKERS.length > 0) {
    pollers.push(
      new OfferGroupsPoller(
        { cron: env.POLL_CRON_MAKE_ORDERS, makers: env.WATCH_MAKERS },
        { cursors, dispatcher, logger, client, minAssets: env.FILTER_MIN_ASSETS }
      )
    )
  } else {
    logger.info('make_orders.disabled', { reason: 'WATCH_MAKERS is empty' })
  }
  return pollers
}

// Slack is opt-in: with SLACK_CHANNEL set, alerts post via chat.postMessage (the bot token is a
// secret read at point of use, never stored on the env object); otherwise alerts stay log-only.
// Setting exactly one of channel/token is a misconfiguration and fails the boot loudly.
export function buildDispatcher(env: MonitorEnv, logger: Logger): AlertDispatcher {
  const token = process.env.SLACK_BOT_TOKEN?.trim()
  if (env.SLACK_CHANNEL && !token) {
    throw new Error('SLACK_BOT_TOKEN is required when SLACK_CHANNEL is set')
  }
  if (!env.SLACK_CHANNEL && token) {
    throw new Error('SLACK_CHANNEL is required when SLACK_BOT_TOKEN is set')
  }
  if (!env.SLACK_CHANNEL || !token) {
    logger.info('slack.disabled', { reason: 'SLACK_CHANNEL is unset — alerts log only' })
    return new LogAlertDispatcher(logger)
  }
  return new SlackDispatcher({ token, channel: env.SLACK_CHANNEL, logger })
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    { provide: CURSOR_STORE, useClass: InMemoryCursorStore },
    { provide: ALERT_DISPATCHER, useFactory: buildDispatcher, inject: [ENV, LOGGER] },
    {
      provide: POLLERS,
      useFactory: buildPollers,
      inject: [ENV, LOGGER, CURSOR_STORE, ALERT_DISPATCHER]
    },
    PollerRegistrar
  ]
})
export class PollingModule {}
