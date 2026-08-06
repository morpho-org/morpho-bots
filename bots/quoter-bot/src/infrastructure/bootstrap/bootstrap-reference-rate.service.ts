import type { Hex } from 'viem'

import type { BootstrapReferenceRateService } from '../../application/bootstrap/position-bootstrap.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

const WAD = 10n ** 18n
const BPS = 10_000n
const YEAR_SECONDS = 31_536_000n
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
