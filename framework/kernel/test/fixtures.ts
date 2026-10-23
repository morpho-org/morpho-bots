import type { Source } from '@repo/engine'

import { setTimeout as sleep } from 'node:timers/promises'

import type {
  KernelActivity,
  KernelConfig,
  KernelEvent,
  KernelRequest,
  PlanInput,
  TxPayload,
  TypedPayload,
  Validator
} from '../src'
import type { ModelOffer, ModelTree } from './validators'

import { argsOf, decodeCall, encodeCall, fnOf } from './codec'
import {
  MAX_UINT128,
  midnightOffersValidator,
  noCommitmentsValidator,
  OFFER_TREE_TYPES,
  treeRoot
} from './validators'

export const W = {
  account: '0xBot',
  midnight: '0xMidnight',
  mempool: '0xMempool',
  setter: '0xSetterRatifier',
  ecrecover: '0xEcrecoverRatifier',
  executor: '0xExecutor',
  bridge: '0xBridge',
  loan: 'loan:0xUSDC',
  market: 'M1'
} as const

export const FEE = 10n ** 15n
/** A fact expiry past any test's clock: evidence the kernel admits always carries a deadline. */
export const FRESH_UNTIL = 24 * 60 * 60_000

/** A request as the kernel reads it, before the controller authors it. */
export type RawRequest = Extract<KernelEvent, { type: KernelRequest['type'] }>

/** The host's tests hand-build the plans the controller's constructors otherwise author. */
export const unauthored = (
  requests: Source<KernelRequest, 'occurrence'>
): Source<RawRequest, 'occurrence'> => requests

type Notice = Extract<KernelActivity, { type: 'notice' }>

/** An `onActivity` listener that hands `each` the transition's notices, in order. */
export const onNotices =
  (each: (notice: Notice) => void) => (activity: readonly KernelActivity[]) => {
    for (const a of activity) if (a.type === 'notice') each(a)
  }

/** A trusted validator for an effect that spends a resource and leaves nothing behind (a bridge send). */
const transferValidator: Validator = {
  id: 'transfer',
  version: 1,
  claims: payload => payload.kind === 'tx' && payload.to === W.bridge,
  read: payload => {
    const call = payload.kind === 'tx' ? decodeCall(payload) : undefined
    return call?.fn === 'transfer' && typeof call.args.amount === 'bigint'
      ? {
          ok: true,
          creates: [],
          exposes: [],
          carries: [],
          retires: [],
          consumes: { [W.loan]: call.args.amount }
        }
      : { ok: false, reason: 'only transfer is recognized' }
  },
  confirm: () => true
}

export const transfer = (amount: bigint, tag = 't'): TxPayload =>
  encodeCall(W.bridge, 'transfer', { amount, tag })

export const makeConfig = (
  overrides: Partial<KernelConfig> & { markets?: string[] } = {}
): KernelConfig => {
  const { markets, ...rest } = overrides
  return {
    chainId: 8453,
    account: W.account,
    validators: [
      midnightOffersValidator({
        midnight: W.midnight,
        mempool: W.mempool,
        ecrecoverRatifier: W.ecrecover,
        setterRatifier: W.setter,
        markets: markets ?? [W.market]
      }),
      noCommitmentsValidator(W.executor),
      transferValidator
    ],
    policy: {
      targets: [W.midnight, W.mempool, W.setter, W.executor, W.bridge],
      recoveryTargets: [W.midnight, W.account]
    },
    caps: { [W.loan]: 1000n, native: 100n * FEE },
    observedResources: [],
    feeReserve: FEE,
    feePolicy: () => FEE,
    maxSimLagBlocks: 1,
    maxEvidenceAgeBlocks: 64,
    stuckBlocks: 3,
    latchBoundBlocks: 10,
    recoveryBoundMs: 60_000,
    revokeAfterStaleMs: 3_600_000,
    maxRecoveryAttempts: 3,
    maxDispatchLagMs: 5_000,
    ...rest
  }
}

export const offer = (
  group: string,
  maxAssets: bigint,
  options: Partial<ModelOffer> = {}
): ModelOffer => ({
  group,
  buy: true,
  maxAssets,
  expiry: 10_000n,
  marketId: W.market,
  loanToken: '0xUSDC',
  maker: W.account,
  ratifier: W.ecrecover,
  ...options
})

export const tree = (...offers: ModelOffer[]): ModelTree => ({ offers })

/** The one-offer tree most traces publish. */
export const T = tree(offer('g1', 300n))

export const signTree = (t: ModelTree, chainId = 8453n): TypedPayload => ({
  kind: 'typed',
  domain: { chainId, verifyingContract: W.ecrecover },
  types: OFFER_TREE_TYPES,
  primaryType: 'OfferTree',
  message: { root: treeRoot(t) }
})

export const publish = (t: ModelTree, signature?: string): TxPayload =>
  encodeCall(W.mempool, 'publish', { root: treeRoot(t), ...(signature ? { signature } : {}) })

export const ratify = (root: string): TxPayload =>
  encodeCall(W.setter, 'setIsRootRatified', { maker: W.account, root, newIsRootRatified: true })

/** Consumes the whole of `group`: the neutralizer the model validator reads for its offers. */
export const cancel = (group = 'g1'): TxPayload =>
  encodeCall(W.midnight, 'setConsumed', { group, amount: MAX_UINT128, onBehalf: W.account })

export const until = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 5_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const exec = (tag: string): TxPayload => encodeCall(W.executor, 'exec', { tag })

/** Ecrecover quoting: sign the tree, then publish it with the signature (a dependent step). */
export const ecrecoverPlan = (
  intentId: string,
  t: ModelTree,
  extra: Partial<PlanInput> = {}
): PlanInput => ({
  intentId,
  steps: [
    { kind: 'sign', payload: signTree(t), witness: t },
    { kind: 'tx', witness: t }
  ],
  notAfter: 1_000_000,
  basisBlock: 0,
  ...extra
})

export const setterPlan = (intentId: string, t: ModelTree): PlanInput => ({
  intentId,
  steps: [
    { kind: 'tx', payload: ratify(treeRoot(t)), witness: t },
    { kind: 'tx', payload: publish(t), witness: t }
  ],
  notAfter: 1_000_000,
  basisBlock: 0
})

export const liquidationPlan = (intentId: string, extra: Partial<PlanInput> = {}): PlanInput => ({
  intentId,
  steps: [{ kind: 'tx', payload: exec(intentId) }],
  notAfter: 1_000_000,
  basisBlock: 0,
  ...extra
})

export const signatureOf = (payload: TypedPayload) => `sig(${String(payload.message.root)})`
const subject = (payload: TxPayload) => {
  const { group, root, tag } = argsOf(payload)
  const value = group ?? root ?? tag
  return typeof value === 'string' ? value : ''
}

const nameOf = (payload: TxPayload) => fnOf(payload) ?? (payload.data === '0x' ? 'fill' : 'opaque')

export const txHash = (payload: TxPayload, nonce: number, feeLevel: number) =>
  `0x${nameOf(payload)}:${subject(payload)}:n${nonce}:f${feeLevel}`
