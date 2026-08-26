import type { Hex } from 'viem'

import type { BootstrapReferenceRateService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapRate } from '../../domain/bootstrap/position-bootstrap'
import type { TargetRateStrategyConfig } from '../../domain/target-rate'

import { MATURITY_PREMIUM_YEAR_SECONDS as YEAR_SECONDS } from '../../domain/maturity-premium'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

const WAD = 10n ** 18n
const BPS = 10_000n
const MAX_REFERENCE_STALENESS_SECONDS = 300n
const REFERENCE_REFRESH_SECONDS = 3_600n

/** Accrual-aware Morpho Blue supply-share checkpoint. */
export type BlueSupplyCheckpoint = {
  blockNumber: bigint
  timestamp: bigint
  supplyAssetsPerWadShares: bigint
}

/** Historical reader that locates and accrues Blue market checkpoints. */
export interface BlueReferenceReader {
  /** Reads the latest deterministic accrued checkpoint. @returns Latest accrued checkpoint. */
  readLatest(): Promise<BlueSupplyCheckpoint>
  /** Reads a historical accrued checkpoint. @param timestamp - Target unix timestamp. @returns Checkpoint at or before the target. */
  readAtOrBefore(timestamp: bigint): Promise<BlueSupplyCheckpoint>
}

/** Selects a configured target-rate method independently for each workflow market. */
export class StrategyBootstrapReferenceRateService implements BootstrapReferenceRateService {
  /**
   * Creates a per-market strategy selector around the established Blue variable-rate adapter.
   * @param strategies - Validated strategy configuration indexed by workflow market.
   * @param variableRates - Existing Blue market variable-rate average implementation.
   * @param maturityReads - Fresh zero-floored seconds-to-maturity readers, indexed by the markets
   * whose configured maturity premium requires that observation next to every rate read.
   */
  constructor(
    private readonly strategies: ReadonlyMap<Hex, TargetRateStrategyConfig>,
    private readonly variableRates: BootstrapReferenceRateService,
    private readonly maturityReads: ReadonlyMap<Hex, () => Promise<bigint>> = new Map()
  ) {}

  /**
   * Resolves the configured hardcoded value or delegates to the Blue variable-rate average.
   * @param marketId - Workflow market requesting its independently configured target rate.
   * @returns A static observation or the existing Blue variable-rate observation, extended with
   * fresh seconds to maturity when this market's premium configuration requires it.
   * @throws `BootstrapAdapterError` when no strategy exists for the requested market; maturity or
   * variable-rate read failures propagate so the caller can halt instead of quoting stale terms.
   */
  async readRate(marketId: Hex): Promise<BootstrapRate> {
    const strategy = this.strategies.get(marketId)
    if (!strategy) throw new BootstrapAdapterError('target-rate-strategy-missing')
    const [rate, secondsToMaturity] = await Promise.all([
      strategy.strategy === 'variable_rate_avg'
        ? this.variableRates.readRate(marketId)
        : Promise.resolve({
            mode: 'static' as const,
            rateBps: strategy.hardcodedRateBps,
            observationId: `static:${strategy.hardcodedRateBps}:hour:${BigInt(Math.floor(Date.now() / 1_000)) / REFERENCE_REFRESH_SECONDS}`
          }),
      this.maturityReads.get(marketId)?.()
    ])
    return secondsToMaturity === undefined ? rate : { ...rate, secondsToMaturity }
  }
}

/** Default six-hour, RPC-derived Morpho Blue supply-share reference adapter. */
export class BlueBootstrapReferenceRateService implements BootstrapReferenceRateService {
  /** Creates a variable-rate adapter. @param reader - Historical Blue reader. @param lookbackSeconds - Observation window in seconds. @param nowSeconds - Wall-clock unix time source used for freshness checks. */
  constructor(
    private readonly reader: BlueReferenceReader,
    private readonly lookbackSeconds = 21_600n,
    private readonly nowSeconds = () => BigInt(Math.floor(Date.now() / 1_000))
  ) {}

  /**
   * Derives annualized BPS from two accrual-aware supply-share values.
   * @param marketId - Bootstrap market requesting the shared configured Blue reference.
   * @returns Variable rate and stable hourly observation identity.
   * @throws When history, time, or supply-share values cannot produce a positive reference.
   * @remarks Reads only historical RPC state; no API fallback or static fallback is used.
   */
  async readRate(marketId: Hex) {
    void marketId
    const latest = await this.reader.readLatest()
    const latestAge = this.nowSeconds() - latest.timestamp
    if (latestAge < 0n || latestAge > MAX_REFERENCE_STALENESS_SECONDS) {
      throw new BootstrapAdapterError('reference-stale')
    }
    const start = await this.reader.readAtOrBefore(latest.timestamp - this.lookbackSeconds)
    const elapsed = latest.timestamp - start.timestamp
    if (
      elapsed <= 0n ||
      start.supplyAssetsPerWadShares <= 0n ||
      latest.supplyAssetsPerWadShares < start.supplyAssetsPerWadShares
    ) {
      throw new BootstrapAdapterError('reference-checkpoint')
    }
    const returnWad =
      ((latest.supplyAssetsPerWadShares - start.supplyAssetsPerWadShares) * WAD) /
      start.supplyAssetsPerWadShares
    const rateBps = (returnWad * YEAR_SECONDS * BPS) / elapsed / WAD
    if (rateBps <= 0n) throw new BootstrapAdapterError('reference-rate')
    return {
      mode: 'variable' as const,
      rateBps,
      observationId: `hour:${latest.timestamp / REFERENCE_REFRESH_SECONDS}`
    }
  }
}
