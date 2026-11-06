import type { Command, KernelEffects, Payload as KernelPayload, StepSpec } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  Payload,
  Tree,
  type TreeCreateParams
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { parseIntentId } from '@repo/controller'
import {
  midnightCancellation,
  midnightCommitmentGroup,
  midnightPublicationPlan
} from '@repo/validators'

import type { BootstrapActPayload } from '../../application/engine/bootstrap-decision'
import type { Act } from '../../application/engine/decision'
import type { LadderActPayload } from '../../application/engine/ladder-decision'

import { UnplannedPublicationError } from '../../errors'
import { DRY_SIGNATURE } from '../kernel/dry-world'

type Publication =
  | Extract<LadderActPayload, { publication: unknown }>
  | Extract<BootstrapActPayload, { publication: unknown }>

/** Who the quoter's plans sign as, and how a tree is ratified on its chain. */
export type QuoterSigning = Readonly<{
  chainId: number
  maker: Address
  signer: Address
  /** Resolved only when a publication is planned, so a run that publishes nothing never needs it. */
  ratifier: () => 'ecrecover' | 'setter'
}>

/** The tree a replacement publishes, as its act recorded it. */
const treeOf = (act: Act): TreeCreateParams | undefined =>
  act.kind === 'replace' ? (act.payload as unknown as Publication).publication.witness : undefined

/**
 * The kernel steps of one act: a cancellation of the groups it names, if any, then for a
 * replacement the publication of its prepared tree, whose dependent step the materializer builds.
 * @param signing - Chain, maker, signer, and the lazily resolved ratifier kind.
 * @param act - The act to plan.
 * @returns The ordered steps; empty for a cancellation that names no group.
 */
export const quoterSteps = (signing: QuoterSigning, act: Act): StepSpec[] => {
  const cancel = (act.payload as unknown as { cancel: readonly string[] }).cancel
  const cancellation: StepSpec[] =
    cancel.length === 0
      ? []
      : [
          {
            kind: 'tx',
            payload: midnightCancellation(
              signing.chainId,
              signing.maker,
              cancel.map(id => midnightCommitmentGroup(id))
            )
          }
        ]
  const witness = treeOf(act)
  if (witness === undefined) return cancellation
  const { steps } = midnightPublicationPlan({
    ...signing,
    ratifier: signing.ratifier(),
    tree: Tree.create(witness)
  })
  return [...cancellation, ...steps]
}

/**
 * The publication a dry run hands the kernel: an Ecrecover tree's leaves carrying the dry signature,
 * unverified, since no one signed. A Setter publication needs no signature and is built as live.
 */
const dryEcrecover = async (chainId: number, witness: TreeCreateParams) => {
  const tree = Tree.create(witness)
  const items = tree.offers.map((offer, leafIndex) => ({
    offer,
    ratifierData: EcrecoverRatifierUtils.ratifierData({
      tree,
      leafIndex: BigInt(leafIndex),
      signature: DRY_SIGNATURE as Hex
    })
  }))
  return {
    payload: {
      kind: 'tx' as const,
      to: getChainAddress(chainId, 'midnightMempool'),
      data: await Payload.encode(items),
      value: 0n
    } satisfies KernelPayload,
    witness
  }
}

/**
 * Builds the dependent step of each replacement from the tree its plan carries on that step: the
 * publication once its ratification is signed or included, checked by `validate` after a Setter
 * ratification. A dry run's Ecrecover publication carries the dry signature unverified, and its
 * Setter publication skips the check, since its root was never ratified on the chain.
 * @param parameters - Signing, the post-ratification validator, and whether the run is dry.
 * @returns The kernel's materialize effect; it throws `UnplannedPublicationError` for a step that
 * carries no tree, or an intent that names no quoter market.
 */
export const quoterMaterializer = (
  parameters: QuoterSigning &
    Readonly<{
      validate: (workflow: 'ladder' | 'bootstrap', tree: Tree, payload: Hex) => Promise<void>
      dry: boolean
    }>
): KernelEffects['materialize'] => {
  return async (command: Extract<Command, { type: 'materialize' }>, signal) => {
    const witness = command.witness as TreeCreateParams | undefined
    const [workflow] = (parseIntentId(command.intentId)?.key ?? '').split(':')
    if (witness === undefined || (workflow !== 'ladder' && workflow !== 'bootstrap'))
      throw new UnplannedPublicationError()
    const ratifier = parameters.ratifier()
    if (parameters.dry && ratifier === 'ecrecover') return dryEcrecover(parameters.chainId, witness)
    const tree = Tree.create(witness)
    const { validate, dry, ...signing } = parameters
    const { materialize } = midnightPublicationPlan({
      ...signing,
      ratifier,
      tree,
      ...(!dry && { validate: (payload: Hex) => validate(workflow, tree, payload) })
    })
    return materialize(command, signal)
  }
}
