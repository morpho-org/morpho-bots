import type { Hex } from 'viem'

import type { BootstrapReferenceRateService } from '../../application/position-bootstrap.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

const WAD = 10n ** 18n
const BPS = 10_000n
const YEAR_SECONDS = 31_536_000n

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
  /** Creates a variable-rate adapter. @param reader - Historical Blue reader. @param lookbackSeconds - Observation window in seconds. */
  constructor(
    private readonly reader: BlueReferenceReader,
    private readonly lookbackSeconds = 21_600n
  ) {}

  /**
   * Derives annualized BPS from two accrual-aware supply-share values.
   * @param marketId - Bootstrap market requesting the shared configured Blue reference.
   * @returns Variable rate and stable block-range observation identity.
   * @throws When history, time, or supply-share values cannot produce a positive reference.
   * @remarks Reads only historical RPC state; no API fallback or static fallback is used.
   */
  async readRate(marketId: Hex) {
    void marketId
    const latest = await this.reader.readLatest()
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
      observationId: `blocks:${start.blockNumber}-${latest.blockNumber}`
    }
  }
}
