import { createLogger } from '@repo/kit'
import { hasTelemetryConfig, startBotTelemetry } from '@repo/telemetry'

import { VersionService } from './application/quoter-bot/version.service'
import { createApplication } from './bootstrap'
import { journalSettings } from './config/journal-settings.utils'
import { resolveObservabilityChainId } from './config/observability-chain.utils'
import { runQuoterBotEntrypoint } from './infrastructure/cli/quoter-bot-entrypoint'
import { enhanceVerboseArgv } from './infrastructure/cli/verbose-argv.utils'
import { createMonitoringLogger } from './infrastructure/observability/monitoring-logger.utils'
import {
  createRecordShipper,
  installProcessObservers
} from './infrastructure/observability/record-shipper.utils'
import { createTelemetryRecordObserver } from './infrastructure/observability/telemetry-metrics.utils'

// oxlint-disable-next-line eslint/no-extend-native -- CLI root policy requested by maintainers.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  configurable: true,
  value(this: bigint) {
    return this.toString()
  }
})

const shutdown = new AbortController()
const requestShutdown = () => shutdown.abort()
process.once('SIGINT', requestShutdown)
process.once('SIGTERM', requestShutdown)

// Resolved once, from the same sources configuration reads, so the observability record and its
// monitoring logger always report the chain the bot actually runs on; reading only the environment
// would mislabel a mainnet run configured through YAML alone.
const chainId = await resolveObservabilityChainId(process.env, process.argv.slice(2))

const build = (() => {
  try {
    return journalSettings(process.env).build
  } catch {
    return undefined
  }
})()
const monitoringLogger = createMonitoringLogger({
  bot: 'quoter-bot',
  chainId,
  ...(build && { build })
})
// The stderr-only fallback keeps `otel.*` lifecycle lines visible whenever telemetry is on and
// shipping is not fully configured — including a partial Better Stack setup, where it is built
// against an empty environment so it neither ships nor emits a second `logship.misconfigured`.
// A plain local run (no telemetry opt-in) stays silent.
const telemetryLogger =
  monitoringLogger ??
  (hasTelemetryConfig(process.env)
    ? createLogger('info', { env: {}, context: { bot: 'quoter-bot', chainId, ...build } })
    : undefined)
// Registered before any application work so outbound-request instrumentation observes every
// provider call. Disabled entirely without an OTLP endpoint opt-in; never throws.
const telemetry = startBotTelemetry({
  serviceName: 'quoter-bot',
  serviceVersion: new VersionService().getVersion(),
  attributes: { chainId },
  logger: telemetryLogger
})

const shipper = createRecordShipper(monitoringLogger)
const removeProcessObservers = installProcessObservers(shipper)

const recordObserver = telemetry.enabled ? createTelemetryRecordObserver() : undefined
const entrypointObservability = recordObserver
  ? {
      record(value: unknown) {
        recordObserver.record(value)
        shipper.record(value)
      },
      unexpected(error: unknown, origin: 'entrypoint') {
        shipper.unexpected(error, origin)
      }
    }
  : shipper

try {
  process.exitCode = await runQuoterBotEntrypoint(
    createApplication(),
    enhanceVerboseArgv(process.argv.slice(2), {
      env: process.env,
      hasAdditionalSink: telemetry.enabled
    }),
    {
      writeOut: value => console.log(value),
      writeError: value => console.error(value)
    },
    { signal: shutdown.signal },
    entrypointObservability
  )
} finally {
  removeProcessObservers()
  process.removeListener('SIGINT', requestShutdown)
  process.removeListener('SIGTERM', requestShutdown)
  await telemetry.shutdown()
}
