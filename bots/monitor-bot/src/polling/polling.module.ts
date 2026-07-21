import type { Logger } from '@repo/bot-kit'

import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import type { AlertDispatcher } from '../alerts/alert'
import type { MonitorEnv } from '../config/env'
import type { CursorStore } from '../cursor/cursor.store'
import type { MidnightEventType } from '../midnight/client'
import type { BootSnapshotStore } from '../snapshot/boot-snapshot.store'
import type { WalletCrmStore } from '../wallets/wallet-crm.store'

import { ALERT_DISPATCHER, LogAlertDispatcher } from '../alerts/alert'
import { AlertFormatter } from '../alerts/formatter'
import { LifecycleNotifier } from '../alerts/lifecycle.notifier'
import { SlackDispatcher } from '../alerts/slack.dispatcher'
import { ENV } from '../config/env'
import { createCoreClient } from '../core/client'
import { CURSOR_STORE, InMemoryCursorStore } from '../cursor/cursor.store'
import { LOGGER } from '../logging/logger.provider'
import { createMidnightClient } from '../midnight/client'
import { MarketDirectory } from '../midnight/markets'
import { BookOffersPoller } from '../pollers/book-offers.poller'
import { TransactionFilter } from '../pollers/filter'
import { MarketTransactionsPoller } from '../pollers/market-transactions.poller'
import { BOOT_SNAPSHOT_STORE, InMemoryBootSnapshotStore } from '../snapshot/boot-snapshot.store'
import { TokenMetadataLoader } from '../tokens/metadata'
import { TokenPriceCache } from '../tokens/prices'
import { TOKEN_REGISTRY, TokenRegistry } from '../tokens/registry'
import { WALLET_CRM_STORE } from '../wallets/wallet-crm.store'
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
  snapshots: BootSnapshotStore,
  dispatcher: AlertDispatcher,
  tokens: TokenRegistry,
  wallets: WalletCrmStore
) {
  // A secret read at point of use (like SLACK_BOT_TOKEN), never stored on the env object. Sent to
  // both services: the core API requires it, the Midnight API tolerates it.
  const apiKey = process.env.MORPHO_API_KEY?.trim() || undefined
  // Always attached so request failures surface at any log level; per-response lines are the part
  // gated on debug, since they cost a body clone + parse the logger would otherwise discard.
  const client = createMidnightClient(env.MIDNIGHT_API_URL, {
    logger,
    verbose: env.LOG_LEVEL === 'debug',
    apiKey
  })
  // The core API serves token metadata and prices as a separate key-authenticated service, so it
  // gets its own client and base URL, shared by both loaders.
  const coreClient = createCoreClient(env.CORE_API_URL, { apiKey })
  const tokenMetadata = new TokenMetadataLoader({ client: coreClient, logger, tokens })
  const prices = new TokenPriceCache({ client: coreClient, logger, tokens })
  const directory = new MarketDirectory({
    client,
    logger,
    fixedMarketIds: env.MARKET_IDS,
    refreshMs: env.MARKETS_REFRESH_MS,
    tokens,
    tokenMetadata,
    tokenPrices: prices
  })
  const filter = new TransactionFilter({
    minAssets: env.FILTER_MIN_ASSETS,
    users: env.FILTER_USERS
  })
  // Every poller hands its items to the formatter to build alerts — it holds the token registry,
  // price cache, and wallet CRM store so the pollers no longer thread those through each format
  // call. The wallet store lets the formatter swap a tracked counterparty's hex for its company name.
  const formatter = new AlertFormatter({ tokens, prices, wallets })
  // Transaction pollers resume from a watermark, so their state is a cursor.
  const deps = { state: cursors, dispatcher, logger, tokens, formatter, client, directory, filter }
  const pollers: (MarketTransactionsPoller | BookOffersPoller)[] = pollerDefinitions(env).map(
    options => new MarketTransactionsPoller(options, deps)
  )
  // Make orders are read straight off the books, so this poller is always on — it scopes itself
  // with MARKET_IDS when set and sweeps every active book otherwise. It does not use the
  // MarketDirectory: `/v0/midnight/books` is itself the active-market universe for books, and it
  // already carries the price levels needed to skip empty sides and size unit-capped offers.
  // Its state is a BootSnapshotStore, not a cursor — the book has no change feed to resume within.
  pollers.push(
    new BookOffersPoller(
      { cron: env.POLL_CRON_MAKE_ORDERS, marketIds: env.MARKET_IDS },
      {
        state: snapshots,
        dispatcher,
        logger,
        tokens,
        formatter,
        client,
        minAssets: env.FILTER_MIN_ASSETS
      }
    )
  )
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
    { provide: BOOT_SNAPSHOT_STORE, useClass: InMemoryBootSnapshotStore },
    { provide: TOKEN_REGISTRY, useClass: TokenRegistry },
    { provide: ALERT_DISPATCHER, useFactory: buildDispatcher, inject: [ENV, LOGGER] },
    {
      provide: POLLERS,
      useFactory: buildPollers,
      inject: [
        ENV,
        LOGGER,
        CURSOR_STORE,
        BOOT_SNAPSHOT_STORE,
        ALERT_DISPATCHER,
        TOKEN_REGISTRY,
        WALLET_CRM_STORE
      ]
    },
    PollerRegistrar,
    LifecycleNotifier
  ]
})
export class PollingModule {}
