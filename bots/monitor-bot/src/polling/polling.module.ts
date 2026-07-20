import type { Logger } from '@repo/bot-kit'

import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import type { AlertDispatcher } from '../alerts/alert'
import type { MonitorEnv } from '../config/env'
import type { CursorStore } from '../cursor/cursor.store'
import type { MidnightEventType } from '../midnight/client'

import { ALERT_DISPATCHER, LogAlertDispatcher } from '../alerts/alert'
import { ENV } from '../config/env'
import { CURSOR_STORE, InMemoryCursorStore } from '../cursor/cursor.store'
import { LOGGER } from '../logging/logger.provider'
import { createMidnightClient } from '../midnight/client'
import { MarketDirectory } from '../midnight/markets'
import { TransactionFilter } from '../pollers/filter'
import { MarketTransactionsPoller } from '../pollers/market-transactions.poller'
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
    refreshMs: env.MARKETS_REFRESH_SECONDS * 1000
  })
  const filter = new TransactionFilter({
    minAssets: env.FILTER_MIN_ASSETS,
    users: env.FILTER_USERS
  })
  const deps = { cursors, dispatcher, logger, client, directory, filter }
  return pollerDefinitions(env).map(options => new MarketTransactionsPoller(options, deps))
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    { provide: CURSOR_STORE, useClass: InMemoryCursorStore },
    { provide: ALERT_DISPATCHER, useClass: LogAlertDispatcher },
    {
      provide: POLLERS,
      useFactory: buildPollers,
      inject: [ENV, LOGGER, CURSOR_STORE, ALERT_DISPATCHER]
    },
    PollerRegistrar
  ]
})
export class PollingModule {}
