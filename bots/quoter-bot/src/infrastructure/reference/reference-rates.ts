import type { Hex } from 'viem'

import { MathLib } from '@morpho-org/morpho-ts'
import { createPublicClient, http } from 'viem'

import type { Read } from '../../application/engine/readings'
import type { OperatorAdapterErrorClass } from '../../application/monitoring/operator-error-name.utils'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapRate } from '../../domain/position-bootstrap'
import type { TargetRateStrategyConfig } from '../../domain/target-rate'
import type { HistoricalBlockReader } from './blue-reference-reader.utils'

import {
  adapterOperationField,
  operatorErrorName
} from '../../application/monitoring/operator-error-name.utils'
import { supportedChain } from '../../config/supported-chains.utils'
import { MATURITY_PREMIUM_YEAR_SECONDS as YEAR_SECONDS } from '../../domain/maturity-premium'
import { BootstrapAdapterError, LadderAdapterError } from '../../errors'
import { createBlueReferenceReader } from './blue-reference-reader.utils'

const WAD = MathLib.WAD
const BPS = 10_000n
const MAX_REFERENCE_STALENESS_SECONDS = 300n
const MAX_REFERENCE_FUTURE_SKEW_SECONDS = 1n
const REFERENCE_REFRESH_SECONDS = 3_600n

/** Accrual-aware Morpho Blue supply-share checkpoint. */
export type BlueSupplyCheckpoint = {
  blockNumber: bigint
  timestamp: bigint
  supplyAssetsPerWadShares: bigint
}

/** Historical reader that locates and accrues Blue Market checkpoints. */
export interface BlueReferenceReader {
  /** Reads the latest deterministic accrued checkpoint. @returns Latest accrued checkpoint. */
  readLatest(): Promise<BlueSupplyCheckpoint>
  /**
   * Reads a historical accrued checkpoint on the chain view ending at `head`.
   * @param timestamp - Target unix timestamp.
   * @param head - Block the search descends from, so both checkpoints share one chain head.
   * @returns Checkpoint at or before the target.
   */
  readAtOrBefore(
    timestamp: bigint,
    head: Pick<BlueSupplyCheckpoint, 'blockNumber' | 'timestamp'>
  ): Promise<BlueSupplyCheckpoint>
}

/** One market whose reference a strategy decides from. */
export type ReferenceMarket = Readonly<{ strategy: 'ladder' | 'bootstrap'; marketId: Hex }>

/**
 * Reads every requested market's reference observation, in request order, each failure kept as a
 * value; every variable-rate market of one call shares one Blue history read.
 */
export type ReferenceRates = (
  markets: readonly ReferenceMarket[]
) => Promise<readonly Read<BootstrapRate>[]>

const ADAPTER_ERRORS: Readonly<Record<ReferenceMarket['strategy'], OperatorAdapterErrorClass>> = {
  ladder: LadderAdapterError,
  bootstrap: BootstrapAdapterError
}

type BlueWindow =
  | Readonly<{ stale: true }>
  | Readonly<{ latest: BlueSupplyCheckpoint; start: BlueSupplyCheckpoint }>

const failure = (error: unknown): Read<never> => ({
  ok: false,
  errorName: operatorErrorName(error),
  ...adapterOperationField(error)
})

/** The annualized supply-share growth over one window, as the calling strategy names its failures. */
const variableRate = (window: BlueWindow, adapterError: OperatorAdapterErrorClass) => {
  if ('stale' in window) throw new adapterError('reference-stale')
  const { latest, start } = window
  const elapsed = latest.timestamp - start.timestamp
  if (
    elapsed <= 0n ||
    start.supplyAssetsPerWadShares <= 0n ||
    latest.supplyAssetsPerWadShares < start.supplyAssetsPerWadShares
  )
    throw new adapterError('reference-checkpoint')
  const returnWad =
    ((latest.supplyAssetsPerWadShares - start.supplyAssetsPerWadShares) * WAD) /
    start.supplyAssetsPerWadShares
  const rateBps = (returnWad * YEAR_SECONDS * BPS) / elapsed / WAD
  if (rateBps <= 0n) throw new adapterError('reference-rate')
  return {
    mode: 'variable' as const,
    rateBps,
    observationId: `hour:${latest.timestamp / REFERENCE_REFRESH_SECONDS}`
  }
}

/**
 * Both strategies' reference rates: each market's configured hardcoded rate, or the Morpho Blue
 * supply-share average over the configured lookback, read from archive RPC with no fallback.
 * @param parameters - `targets`: each strategy's target-rate method per market, which may differ
 * between strategies; the Blue `reader` and `lookbackSeconds`; and `nowSeconds`, wall-clock unix
 * time for the latest checkpoint's freshness and a hardcoded observation's hourly identity.
 * @returns A reader that resolves one read per market, in order; a failure is a value, never a throw.
 */
export const createReferenceRates = (parameters: {
  targets: Readonly<Record<ReferenceMarket['strategy'], ReadonlyMap<Hex, TargetRateStrategyConfig>>>
  reader: BlueReferenceReader
  lookbackSeconds: bigint
  nowSeconds?: () => bigint
}): ReferenceRates => {
  const nowSeconds = parameters.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1_000)))
  const readWindow = async (): Promise<BlueWindow> => {
    const latest = await parameters.reader.readLatest()
    const age = nowSeconds() - latest.timestamp
    if (age < -MAX_REFERENCE_FUTURE_SKEW_SECONDS || age > MAX_REFERENCE_STALENESS_SECONDS)
      return { stale: true }
    const start = await parameters.reader.readAtOrBefore(
      latest.timestamp - parameters.lookbackSeconds,
      latest
    )
    return { latest, start }
  }
  return async markets => {
    const targets = markets.map(market => parameters.targets[market.strategy].get(market.marketId))
    const window = targets.some(target => target?.strategy === 'variable_rate_avg')
      ? await readWindow().then(
          (value): Read<BlueWindow> => ({ ok: true, value }),
          (error: unknown) => failure(error)
        )
      : undefined
    return markets.map((market, index): Read<BootstrapRate> => {
      const adapterError = ADAPTER_ERRORS[market.strategy]
      const target = targets[index]
      try {
        if (!target) throw new adapterError('target-rate-strategy-missing')
        if (target.strategy === 'hardcoded')
          return {
            ok: true,
            value: {
              mode: 'static',
              rateBps: target.hardcodedRateBps,
              observationId: `static:${target.hardcodedRateBps}:hour:${nowSeconds() / REFERENCE_REFRESH_SECONDS}`
            }
          }
        if (!window!.ok) return window as Read<never>
        return { ok: true, value: variableRate(window!.value, adapterError) }
      } catch (error) {
        return failure(error)
      }
    })
  }
}

/**
 * The production reference rates: each strategy's configured targets over the archive RPC.
 * @param config - Validated runtime config.
 * @returns The reference reader; no request is made until it is called.
 */
export const productionReferenceRates = (config: ConfigService): ReferenceRates =>
  createReferenceRates({
    targets: {
      ladder: new Map(config.ladder.map(item => [item.marketId, item.targetRate] as const)),
      bootstrap: new Map(config.bootstrap.map(item => [item.marketId, item.targetRate] as const))
    },
    reader: createBlueReferenceReader(
      config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      createPublicClient({
        chain: supportedChain(config.chainId),
        transport: http(config.referenceRpcUrl ?? config.rpcUrl, {
          timeout: config.requestTimeoutMs
        })
      }) as HistoricalBlockReader,
      config.chainId
    ),
    lookbackSeconds: config.referenceLookbackSeconds
  })
