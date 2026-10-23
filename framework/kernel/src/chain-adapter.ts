import type { Hash, Id, KernelConfig, KernelEvent, KernelState, Log } from './types'

import { pollSet } from './kernel'

/** Nonce lookups bisect history, so each poll runs only this many, after every other read. */
const LOOKUPS_PER_POLL = 4

/** A `Reorg` below every height: the kernel drops all evidence and re-learns it from the chain. */
const NO_SURVIVING_HEIGHT = -1

export type Block = { number: number; hash: Hash; parentHash: Hash; timestamp: bigint }

type ChainEvidence = {
  block: number
  blockHash: Hash
  status: 'success' | 'reverted'
  logs: readonly Log[]
}

/** The kernel's own chain reads. They never wait on the bot's, and every read at a block is pinned by its hash. */
export type KernelChain = {
  latest(): Promise<{ head: Block; finalized: { number: number; timestamp: bigint } }>
  block(number: number): Promise<Block>
  nonceAt(at: Block): Promise<{ latest: number; pending: number }>
  /** The signing account's code at the latest block, `0x` for a plain account. */
  accountCode(): Promise<string>
  receipt(hash: Hash): Promise<ChainEvidence | null>
  /** The account's transaction at `nonce`, once one is mined. */
  nonceTx(nonce: number): Promise<(ChainEvidence & { hash: Hash }) | null>
  commitment(id: Id, at: Block): Promise<{ consumed: bigint; neutralized: boolean }>
  capacity(resource: string, at: Block): Promise<bigint>
}

/** What the adapter is asked to do: poll the chain, or identify the transaction at a nonce. */
type ChainRequest = { type: 'poll' } | { type: 'findNonceTx'; nonce: number }

/** How the adapter reaches the kernel: it writes chain events and reads the kernel's current state. */
type ChainPort = { signal: AbortSignal; write(event: KernelEvent): void; state(): KernelState }

type ChainAdapterOptions = {
  chain: KernelChain
  config: KernelConfig
  effectTimeoutMs: number
  /** How many delivered blocks are kept to find a fork point; a deeper reorg halts the kernel. */
  reorgDepth: number
  onError: (source: string, error: unknown) => void
}

/**
 * The kernel's chain source: follows the head, rolls back to a fork before it delivers any block on
 * the new branch, and reads receipts, nonces, commitments and capacity pinned to the delivered tip.
 */
export const createChainAdapter = (options: ChainAdapterOptions) => {
  const { chain } = options
  let port: ChainPort | undefined
  const stopped = () => port?.signal.aborted === true
  /** Once the runner stops, the poll ends quietly: what it would report no longer reaches anyone. */
  const fail = (source: string, error: unknown) => {
    if (!stopped()) options.onError(source, error)
  }
  const dispatch = (event: KernelEvent) => port?.write(event)
  const state = () => port!.state()

  const delivered = new Map<number, Block>()
  let tip: Block | undefined
  /** Bumped by every evidence reset; a read that began under an older one delivers nothing. */
  let generation = 0
  /** Nonces the kernel asked to identify; looked up inside the poll so no chain read runs beside another. */
  const lookups = new Set<number>()
  /** The last finalized block seen; a change to it is a finality violation the kernel cannot see once its header is pruned. */
  let anchor: Block | undefined

  /**
   * A chain read that outlives the effect timeout is abandoned, so one hung call never stops the
   * poll; once the runner stops, the poll makes no further read and goes no further after one.
   */
  const timed = <T>(work: () => Promise<T>): Promise<T> => {
    const halted = () => new Error('the runner stopped')
    if (stopped()) return Promise.reject(halted())
    const read = work()
    let deadline: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('chain read timed out')),
        options.effectTimeoutMs
      )
    })
    return Promise.race([read, late])
      .finally(() => clearTimeout(deadline))
      .then(value => (stopped() ? Promise.reject(halted()) : value))
  }

  const halt = (reason: string) => dispatch({ type: 'Halt', reason })

  /**
   * No height is proved to survive, so every piece of evidence the kernel holds is rolled back, and
   * nothing is delivered until the next poll reads a fresh head.
   */
  const forgetAllEvidence = (reason: string) => {
    halt(reason)
    dispatch({ type: 'Reorg', fork: NO_SURVIVING_HEIGHT })
    delivered.clear()
    tip = undefined
    generation++
  }

  /** Re-reads the anchor; a changed finalized block resets all evidence and becomes the anchor. */
  const anchorHolds = async () => {
    if (!anchor) return true
    const { number } = anchor
    const current = await timed(() => chain.block(number))
    if (current.hash === anchor.hash) return true
    forgetAllEvidence('finality violated: a finalized block changed')
    anchor = current
    return false
  }

  /**
   * The anchor moves only to a block proved to lie on the branch just delivered, and finality reaches
   * the kernel only once it has: a failed or forked read leaves both where they were, to retry.
   */
  const advanceAnchor = async (finalized: { number: number; timestamp: bigint }) => {
    if (!tip || finalized.number <= (anchor?.number ?? -1) || finalized.number > tip.number) return
    const candidate = delivered.get(finalized.number) ?? (await linkedAt(finalized.number))
    if (!candidate) return
    anchor = candidate
    deliverHead(tip, finalized)
  }

  /** The block at `number` below the retained window, reached by parent links from its oldest block. */
  const linkedAt = async (number: number) => {
    const oldest = delivered.get(Math.min(...delivered.keys()))
    if (!oldest) return undefined
    const linked = await ancestry(oldest, first => first.number <= number, number)
    return linked?.[0]?.number === number ? linked[0] : undefined
  }

  /**
   * The hash to vouch for at `number`, or nothing to deliver: above the tip, or at or below
   * finality when the anchor no longer holds after reading it.
   */
  const vouchedAt = async (number: number) => {
    if (!tip || number > tip.number) return undefined
    const hash = delivered.get(number)?.hash ?? (await timed(() => chain.block(number))).hash
    if (number <= (anchor?.number ?? -1) && !(await anchorHolds())) return undefined
    return hash
  }

  /** Delivers `block` as the head, with finality no higher than the anchor proved on its branch. */
  const deliverHead = (block: Block, finalized: { number: number; timestamp: bigint }) => {
    delivered.set(block.number, block)
    for (const number of delivered.keys())
      if (number <= block.number - options.reorgDepth) delivered.delete(number)
    tip = block
    const final = Math.min(finalized.number, block.number, anchor?.number ?? -1)
    const finalBlock =
      final === anchor?.number ? anchor : final === block.number ? block : undefined
    dispatch({
      type: 'Head',
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
      finalized: final,
      finalizedTimestamp: finalBlock?.timestamp ?? 0n
    })
  }

  /** Rolls the kernel and the adapter back to `fork`; reads that began before it deliver nothing. */
  const rollBack = (fork: number) => {
    for (const number of delivered.keys()) if (number > fork) delivered.delete(number)
    generation++
    dispatch({ type: 'Reorg', fork })
  }

  /** An unchanged head still carries finality forward, so final evidence can settle. */
  const refreshFinality = (finalized: { number: number; timestamp: bigint }) =>
    advanceAnchor(finalized)

  /** The hash this adapter knows at `number`, from a delivered block or its delivered child. */
  const knownHash = (number: number) =>
    delivered.get(number)?.hash ?? delivered.get(number + 1)?.parentHash

  /** Fetches `block`'s ancestors down to `floor`, each checked against the link it continues. */
  const ancestry = async (block: Block, stop: (oldest: Block) => boolean, floor: number) => {
    const chainOf = [block]
    while (!stop(chainOf[0]!)) {
      const parent = chainOf[0]!.number - 1
      if (parent < floor) return undefined
      const fetched = await timed(() => chain.block(parent))
      if (fetched.hash !== chainOf[0]!.parentHash)
        throw new Error('the chain source changed forks while the adapter walked back')
      chainOf.unshift(fetched)
    }
    return chainOf
  }

  /**
   * Delivers every block from the last one delivered to the chain's head, each linked to the one
   * before it, rolling back to the fork first. The first poll delivers the window above finality.
   * A head behind the tip rolls back to it unless the tip still exists. A fork older than the
   * retained blocks drops all evidence, since nothing proves which of it survived.
   */
  const followHead = async () => {
    const { head, finalized } = await timed(() => chain.latest())
    if (!(await anchorHolds())) return
    if (!tip) {
      const floor = Math.max(finalized.number, head.number - options.reorgDepth + 1, 0)
      const window = await ancestry(head, oldest => oldest.number <= floor, floor)
      for (const block of window ?? [head]) deliverHead(block, finalized)
      return advanceAnchor(finalized)
    }
    if (head.number < tip.number) {
      const height = tip.number
      const ours = await timed(() => chain.block(height)).catch(() => undefined)
      if (ours?.hash === tip.hash) return refreshFinality(finalized)
    } else if (delivered.get(head.number)?.hash === head.hash) return refreshFinality(finalized)
    if (knownHash(head.number) === head.hash) {
      rollBack(head.number)
      deliverHead(head, finalized)
      return advanceAnchor(finalized)
    }
    const oldest = Math.min(...delivered.keys())
    const fresh = await ancestry(
      head,
      first => knownHash(first.number - 1) === first.parentHash,
      oldest
    )
    if (!fresh) return forgetAllEvidence('reorg deeper than the adapter retains')
    const fork = fresh[0]!.number - 1
    if (fork < tip.number) rollBack(fork)
    for (const block of fresh) deliverHead(block, finalized)
    await advanceAnchor(finalized)
  }

  /**
   * One evidence read; its failure is reported and skipped, so it never starves the others. A step
   * that mutates adapter state is never timed as a whole, so it cannot outlive the poll it is in.
   */
  const attempt = async <T>(source: string, work: () => Promise<T>, whole = timed) => {
    try {
      return await whole(() => Promise.resolve().then(work))
    } catch (error) {
      fail(source, error)
      return undefined
    }
  }

  type Current = () => boolean

  /** Delivers evidence at `block` after vouching for it; `false` once the tip it was read at is gone. */
  const deliverVouched = async (
    block: number,
    current: Current,
    evidence: Extract<KernelEvent, { type: 'Receipt' | 'NonceTx' }>
  ) => {
    const header = await attempt(
      'block',
      () => vouchedAt(block),
      read => read()
    )
    if (!current()) return false
    if (header === undefined) return true
    dispatch({ type: 'Header', number: block, hash: header })
    dispatch(evidence)
    return true
  }

  const readLookups = async (current: Current) => {
    for (const lookup of [...lookups].slice(0, LOOKUPS_PER_POLL)) {
      lookups.delete(lookup)
      const found = await attempt('nonceTx', () => chain.nonceTx(lookup))
      if (!current()) return
      if (found === undefined) lookups.add(lookup)
      if (!found) continue
      if (
        !(await deliverVouched(found.block, current, { type: 'NonceTx', nonce: lookup, ...found }))
      )
        return
    }
  }

  /** Reads pinned to one tip; they stop as soon as that tip is no longer the one delivered. */
  const readAtTip = async () => {
    const at = tip
    if (!at) return
    const began = generation
    const current = () => tip === at && generation === began && !stopped()
    const pinned = { block: at.number, blockHash: at.hash }
    const nonce = await attempt('nonceAt', () => chain.nonceAt(at))
    if (!current()) return
    if (nonce) dispatch({ type: 'NonceAt', ...pinned, ...nonce })
    const watched = pollSet(state())
    for (const hash of watched.receipts) {
      const found = await attempt('receipt', () => chain.receipt(hash))
      if (!current()) return
      if (!found) continue
      if (!(await deliverVouched(found.block, current, { type: 'Receipt', hash, ...found }))) return
    }
    for (const id of watched.commitments) {
      const observed = await attempt('commitment', () => chain.commitment(id, at))
      if (!current()) return
      if (observed) dispatch({ type: 'CommitmentObserved', id, ...pinned, ...observed })
    }
    for (const resource of options.config.observedResources) {
      const amount = await attempt('capacity', () => chain.capacity(resource, at))
      if (!current()) return
      if (amount !== undefined) dispatch({ type: 'Capacity', resource, amount, ...pinned })
    }
    await readLookups(current)
  }

  let polling = false
  const poll = async () => {
    if (polling) return
    polling = true
    try {
      await followHead()
      await readAtTip()
    } catch (error) {
      fail('chain', error)
    } finally {
      polling = false
    }
  }

  return {
    accountCode: () => timed(() => chain.accountCode()),
    /** A poll runs beside the request that started it, so a slow chain never holds the effect's lane. */
    handle: (request: ChainRequest, through: ChainPort) => {
      port = through
      if (request.type === 'findNonceTx') lookups.add(request.nonce)
      else void poll()
    }
  }
}
