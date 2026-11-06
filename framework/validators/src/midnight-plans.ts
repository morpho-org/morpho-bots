import type { KernelEffects, StepSpec, TxPayload, TypedPayload } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  MAX_OFFER_CAP,
  midnightAbi,
  type Offer,
  Payload,
  SetterRatifierUtils,
  setterRatifierAbi,
  Tree,
  type TreeCreateParams
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { decodeFunctionResult, encodeFunctionData } from 'viem'

import { midnightCommitmentId, midnightWitness } from './midnight'

const COMMITMENT_PREFIX = midnightCommitmentId('' as Hex)

/** The consumption group a commitment id names; see {@link midnightCommitmentId}. */
export const midnightCommitmentGroup = (commitmentId: string) =>
  commitmentId.slice(COMMITMENT_PREFIX.length) as Hex

/** A tree's groups in leaf order, so the witness rebuilds the same root. */
export const midnightTreeWitness = (tree: Tree): TreeCreateParams => {
  const groups = new Map<Hex, Offer[]>()
  for (const offer of tree.offers)
    groups.set(offer.group, [...(groups.get(offer.group) ?? []), offer])
  const witness = midnightWitness([...groups.values()].map(offers => ({ offers })))
  if (Tree.create(witness).root !== tree.root)
    throw new TypeError('tree witness does not rebuild the tree root')
  return witness
}

/** The ratification typed data exactly as the signer signs it, in the kernel's payload form. */
const ratificationPayload = (tree: Tree, chainId: number): TypedPayload => {
  const typed = EcrecoverRatifierUtils.typedData({ tree, chainId })
  return {
    kind: 'typed',
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message
  } as TypedPayload
}

/** One transaction cancelling every group: a lone `setConsumed`, or a native Midnight multicall of them. */
export const midnightCancellation = (
  chainId: number,
  maker: Address,
  groupIds: readonly Hex[]
): TxPayload => {
  const calls = groupIds.map(groupId =>
    encodeFunctionData({
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [groupId, MAX_OFFER_CAP, maker]
    })
  )
  return {
    kind: 'tx',
    to: getChainAddress(chainId, 'midnight'),
    data:
      calls.length === 1
        ? calls[0]!
        : encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [calls] }),
    value: 0n
  }
}

/**
 * The plan that publishes a tree: sign its ratification then publish (Ecrecover), or ratify its
 * root onchain then publish (Setter). The publication is built only once the first step is done.
 */
export const midnightPublicationPlan = (parameters: {
  chainId: number
  maker: Address
  /** The account that signs an Ecrecover ratification: the maker, or a signer it authorized. */
  signer: Address
  tree: Tree
  ratifier: 'ecrecover' | 'setter'
  /** Checks a Setter publication's exact payload after its ratification lands, before it is sent. */
  validate?: (publication: Hex) => Promise<void>
}): { steps: StepSpec[]; materialize: KernelEffects['materialize'] } => {
  const { chainId, tree } = parameters
  const witness = midnightTreeWitness(tree)
  const publication = async (items: Parameters<typeof Payload.encode>[0]) => ({
    payload: {
      kind: 'tx' as const,
      to: getChainAddress(chainId, 'midnightMempool'),
      data: await Payload.encode(items),
      value: 0n
    },
    witness
  })
  if (parameters.ratifier === 'ecrecover') {
    return {
      steps: [
        { kind: 'sign', payload: ratificationPayload(tree, chainId), witness },
        { kind: 'tx', witness }
      ],
      materialize: async command =>
        publication(
          await EcrecoverRatifierUtils.ratify({
            tree,
            account: parameters.signer,
            signature: command.signatures[0] as Hex
          })
        )
    }
  }
  const ratification: TxPayload = {
    kind: 'tx',
    to: getChainAddress(chainId, 'setterRatifier'),
    data: encodeFunctionData({
      abi: setterRatifierAbi,
      functionName: 'setIsRootRatified',
      args: [parameters.maker, tree.root, true]
    }),
    value: 0n
  }
  return {
    steps: [
      { kind: 'tx', payload: ratification, witness },
      { kind: 'tx', witness }
    ],
    materialize: async () => {
      const built = await publication(SetterRatifierUtils.ratify({ tree }))
      await parameters.validate?.(built.payload.data)
      return built
    }
  }
}

/**
 * The read a kernel's chain source makes to observe one commitment: the maker's consumption of its
 * group, which a cancellation sets to `MAX_OFFER_CAP`.
 */
export const midnightCommitmentRead = (chainId: number, maker: Address) => ({
  request: (commitmentId: string) => ({
    to: getChainAddress(chainId, 'midnight'),
    data: encodeFunctionData({
      abi: midnightAbi,
      functionName: 'consumed',
      args: [maker, midnightCommitmentGroup(commitmentId)]
    })
  }),
  observe: (data: Hex) => {
    const consumed = decodeFunctionResult({ abi: midnightAbi, functionName: 'consumed', data })
    return { consumed, neutralized: consumed >= MAX_OFFER_CAP }
  }
})
