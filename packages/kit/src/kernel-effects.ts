import type { KernelEffects } from '@repo/kernel'
import type { Client, Hex, LocalAccount, TypedDataDefinition } from 'viem'

import { bigintMin, mulDivUp } from '@repo/utils'
import { BaseError, getAddress, isAddressEqual, RpcError, withTimeout } from 'viem'
import { estimateGas, getFeeHistory } from 'viem/actions'

import type { Logger } from './logger'
import type { Signer } from './signer'

import { BLOCK_TIME_MS } from './block-time'
import { FeeLimitError, SignWithdrawnError } from './errors'
import { bumpFees, feeCeiling, initialFees, stepCap } from './fee-policy'
import { callAt } from './kernel-chain'
import { NONCE_FILL_MAX_GAS } from './policy'
import { isCallRevert } from './revert.utils'
import { isAlreadyKnown } from './signer'

const GAS_HEADROOM_NUMERATOR = 120n
const GAS_HEADROOM_DENOMINATOR = 100n

/**
 * A node's own refusal to pool these bytes, which no earlier send of them can have changed. Error
 * codes cannot say this (`-32000` is also a generic server error), so only geth's txpool admission
 * errors count: https://github.com/ethereum/go-ethereum/blob/master/core/txpool/errors.go
 */
const ADMISSION_REFUSAL =
  /replacement transaction underpriced|transaction underpriced|insufficient funds|max fee per gas less than block base fee|fee cap less than block base fee|intrinsic gas too low|exceeds block gas limit|tip higher than fee cap|max priority fee per gas higher than max fee per gas/i

/** The gas limit a payload of `estimatedGas` signs with: 20% headroom, within `maxGasLimit`. */
export const gasLimitFor = (estimatedGas: bigint, maxGasLimit: bigint) =>
  estimatedGas < maxGasLimit
    ? bigintMin(
        mulDivUp(estimatedGas, GAS_HEADROOM_NUMERATOR, GAS_HEADROOM_DENOMINATOR),
        maxGasLimit
      )
    : estimatedGas

/**
 * The first bid {@link createKernelEffects} signs under spend bound `fee`: {@link initialFees} at
 * the tighter of `maxFeePerGas` and what `fee` funds per estimated gas, with `gasLimit` shrunk to
 * what `fee` funds at that max fee. Without `tip`, it tips the most a first bid may.
 */
export const firstBid = (bid: {
  fee: bigint
  estimatedGas: bigint
  baseFee: bigint
  maxFeePerGas: bigint
  gasLimit: bigint
  tip?: bigint
}) => {
  const perGas = bigintMin(bid.maxFeePerGas, bid.fee / bid.estimatedGas)
  if (perGas <= 0n) return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 0n }
  const fees = initialFees(bid.baseFee, perGas, bid.tip)
  return { ...fees, gas: bigintMin(bid.gasLimit, bid.fee / fees.maxFeePerGas) }
}

/**
 * A first bid tips the median, over the last {@link TIP_WINDOW_BLOCKS} blocks, of each block's
 * {@link TIP_PERCENTILE}th-percentile tip, which a single block's spike cannot move.
 */
const TIP_PERCENTILE = 90
const TIP_WINDOW_BLOCKS = 20
/** Well inside every bot's kernel effect deadline, so a stalled fee history cannot stall a bid. */
const MARKET_TIP_TIMEOUT_MS = 2_000

/**
 * The recent market tip, read once at a time and kept for a block time after it settles;
 * `undefined` when the node answers no reward data, fails or is slower than
 * {@link MARKET_TIP_TIMEOUT_MS}, which leaves {@link initialFees} its own tip and warns once.
 */
const createMarketTip = (client: Client, logger: Logger | undefined) => {
  const freshMs = (client.chain && BLOCK_TIME_MS.get(client.chain.id)) ?? 0
  let cached: { settledAt?: number; tip: Promise<bigint | undefined> } | undefined
  let warned = false
  const read = async () => {
    try {
      const { reward } = await withTimeout(
        () =>
          getFeeHistory(client, {
            blockCount: TIP_WINDOW_BLOCKS,
            rewardPercentiles: [TIP_PERCENTILE]
          }),
        { timeout: MARKET_TIP_TIMEOUT_MS }
      )
      const tips = (reward ?? [])
        .flatMap(block => block.slice(0, 1))
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      if (tips.length > 0) return (tips[(tips.length - 1) >> 1]! + tips[tips.length >> 1]!) / 2n
    } catch {}
    if (!warned) logger?.warn('fees.no_market_tip', { blocks: TIP_WINDOW_BLOCKS })
    warned = true
    return undefined
  }
  return () => {
    const { settledAt } = cached ?? {}
    if (!cached || (settledAt !== undefined && Date.now() - settledAt >= freshMs)) {
      const entry: NonNullable<typeof cached> = { tip: read() }
      void entry.tip.then(() => (entry.settledAt = Date.now()))
      cached = entry
    }
    return cached.tip
  }
}

const refusedAdmission = (error: unknown) =>
  error instanceof BaseError &&
  error.walk(e => e instanceof RpcError && ADMISSION_REFUSAL.test(e.details)) !== null

/**
 * The kernel's effects over a kit {@link Signer}. A bid stays within its spend bound and under
 * {@link feeCeiling}, a step's under {@link stepCap}; a replacement bumps `outbid` or is `capped`.
 */
export const createKernelEffects = (options: {
  client: Client
  signer: Signer
  /** Signs the kernel's typed data; the account the signer sends from when omitted. */
  typedSigner?: LocalAccount
  /** The bot's policy ceiling on one gas unit. */
  maxFeePerGasWei: bigint
  /** The signer's gas-limit ceiling for an ordinary payload. */
  maxGasLimit: bigint
  /** Warned once when the node serves no fee history, and first bids tip a quarter of their cap. */
  logger?: Logger
  materialize: KernelEffects['materialize']
}): KernelEffects => {
  const { client, signer } = options
  const from = signer.account.address
  const typedSigner = options.typedSigner ?? (signer.account as LocalAccount)
  const marketTip = createMarketTip(client, options.logger)

  return {
    materialize: options.materialize,
    simulate: async (payload, at, signal) => {
      signal.throwIfAborted()
      try {
        await callAt(client, at, {
          from,
          to: getAddress(payload.to),
          data: payload.data as Hex,
          value: payload.value
        })
        return true
      } catch (error) {
        if (isCallRevert(error)) return false
        throw error
      }
    },
    signTx: async (payload, { nonce, kind, fee, recoveryFee, outbid }, guard) => {
      if (payload.value !== 0n) throw new Error('the kernel signer sends no value')
      const request = {
        to: getAddress(payload.to),
        data: payload.data as Hex,
        value: payload.value
      }
      const estimatedGas = await estimateGas(client, { account: from, ...request })
      guard.signal.throwIfAborted()
      const ceiling = feeCeiling(options.maxFeePerGasWei, recoveryFee)
      const perGas = bigintMin(kind === 'step' ? stepCap(ceiling) : ceiling, fee / estimatedGas)
      const baseFee = await signer.getBaseFee()
      const gasLimit = gasLimitFor(
        estimatedGas,
        isAddressEqual(request.to, from) ? NONCE_FILL_MAX_GAS : options.maxGasLimit
      )
      let signed: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }
      if (outbid) {
        const bumped = bumpFees({ ...outbid, baseFee, maxFeePerGasWei: perGas })
        if (bumped.kind === 'drop') return 'capped'
        signed = { ...bumped.fees, gas: bigintMin(gasLimit, fee / bumped.fees.maxFeePerGas) }
      } else {
        if (perGas <= 0n)
          throw new FeeLimitError('the fee ceiling cannot fund a positive per-gas bid')
        const tip = await marketTip()
        guard.signal.throwIfAborted()
        signed = firstBid({ fee, estimatedGas, baseFee, maxFeePerGas: perGas, gasLimit, tip })
      }
      if (signed.gas < estimatedGas)
        throw new FeeLimitError('the fee ceiling cannot fund the estimated gas')
      const mayAct = () => guard.mayAct()
      const { txHash, raw } = await signer.sign({ ...request, ...signed, nonce, mayAct })
      return { hash: txHash, raw, bid: signed }
    },
    signTyped: async (payload, guard) => {
      if (!guard.mayAct()) throw new SignWithdrawnError()
      return typedSigner.signTypedData(payload as unknown as TypedDataDefinition)
    },
    broadcast: async (raw, guard) => {
      if (!guard.mayAct()) throw new Error('the dispatch was withdrawn before sending')
      try {
        const { broadcastUnknown } = await signer.broadcastRaw(raw as Hex)
        return broadcastUnknown ? 'unknown' : 'accepted'
      } catch (error) {
        if (isAlreadyKnown(error)) return 'accepted'
        return refusedAdmission(error) ? 'rejected' : 'unknown'
      }
    },
    release: () => Promise.reject(new Error('this bot releases nothing offchain'))
  }
}
