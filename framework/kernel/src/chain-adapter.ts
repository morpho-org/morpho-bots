import type { KernelHostOptions } from './host'
import type { Hash, Id, KernelEvent, KernelState, Log } from './types'

import { pollSet, unidentifiedNonces } from './kernel'

/** Nonce lookups bisect history, so each poll runs only this many, after every other read. */
const LOOKUPS_PER_POLL = 4

/** Header reads one walk keeps in flight: a fast chain's poll gap or first window spans many blocks. */
const HEADER_READS_AT_ONCE = 32

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
  /** `finalized` is `null` when the chain does not serve the tag the kernel's finality follows. */
  latest(): Promise<{ head: Block; finalized: { number: number; timestamp: bigint } | null }>
  block(number: number): Promise<Block>
  nonceAt(at: Block): Promise<{ latest: number; pending: number }>
  /**
   * The chain's `safe` block, whatever finality the kernel follows: a fresh enrollment waits on it.
   * `null` when the chain serves no `safe` tag; a read that merely failed rejects.
   */
  safe(): Promise<Block | null>
  /** The signing account's code at the latest block, `0x` for a plain account. */
  accountCode(): Promise<string>
  receipt(hash: Hash): Promise<ChainEvidence | null>
  /** The account's transaction at `nonce`, once one is mined. */
  nonceTx(nonce: number): Promise<(ChainEvidence & { hash: Hash }) | null>
  commitment(id: Id, at: Block): Promise<{ consumed: bigint; neutralized: boolean }>
  capacity(resource: string, at: Block): Promise<bigint>
}

/** How the adapter reaches the kernel: it writes chain events and reads the kernel's current state. */
type ChainPort = { signal: AbortSignal; write(event: KernelEvent): void; state(): KernelState }

type ChainAdapterOptions = Pick<
  KernelHostOptions,
  'chain' | 'config' | 'effectTimeoutMs' | 'reorgDepth' | 'onError'
>

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

  /** Blocks proved to lie on the delivered branch. */
  const retained = new Map<number, Block>()
  let tip: Block | undefined
  /** Bumped by every evidence reset; a read that began under an older one delivers nothing. */
  let generation = 0
  /** The last finalized block seen; a change to it is a finality violation the kernel cannot see once its header is pruned. */
  let anchor: Block | undefined
  /** Whether finality is held below the retained window, so its alarm is raised once. */
  let holding = false
  /** Whether the chain stopped serving the finality tag while running, so its alarm is raised once. */
  let unserved = false

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
    retained.clear()
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
   * The anchor moves only to a retained block, proved to lie on the branch just delivered, and
   * finality reaches the kernel only once it has. A finalized block below the retained window, new
   * or stalled, holds both where they were, with one alarm, until finality comes back inside it.
   */
  const advanceAnchor = (finalized: { number: number; timestamp: bigint }) => {
    if (!tip) return
    if (finalized.number <= tip.number - options.reorgDepth) {
      if (!holding)
        dispatch({
          type: 'Alarm',
          reason: `finality is held: the finalized block lags the head past the ${options.reorgDepth}-block reorg window`
        })
      holding = true
      return
    }
    holding = false
    if (finalized.number <= (anchor?.number ?? -1) || finalized.number > tip.number) return
    const candidate = retained.get(finalized.number)
    if (!candidate) return
    anchor = candidate
    deliverHead(tip, finalized)
  }

  /**
   * The hash to vouch for at `number`, or nothing to deliver: above the tip, or at or below
   * finality when the anchor no longer holds after reading it.
   */
  const vouchedAt = async (number: number) => {
    if (!tip || number > tip.number) return undefined
    const hash = retained.get(number)?.hash ?? (await timed(() => chain.block(number))).hash
    if (number <= (anchor?.number ?? -1) && !(await anchorHolds())) return undefined
    return hash
  }

  /** Delivers `block` as the head, with finality no higher than the anchor proved on its branch. */
  const deliverHead = (block: Block, finalized: { number: number; timestamp: bigint }) => {
    retained.set(block.number, block)
    for (const number of retained.keys())
      if (number <= block.number - options.reorgDepth) retained.delete(number)
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
    for (const number of retained.keys()) if (number > fork) retained.delete(number)
    generation++
    dispatch({ type: 'Reorg', fork })
  }

  /** An unchanged head still carries finality forward, so final evidence can settle. */
  const refreshFinality = (finalized: { number: number; timestamp: bigint }) =>
    advanceAnchor(finalized)

  /** The hash this adapter knows at `number`, from a retained block or its retained child. */
  const knownHash = (number: number) =>
    retained.get(number)?.hash ?? retained.get(number + 1)?.parentHash

  /**
   * Fetches `block`'s ancestors down to `floor`, oldest first, each checked against the link it
   * continues. Reads run {@link HEADER_READS_AT_ONCE} at a time, none below `expected` until the
   * walk passes it, so a walk that stops where expected reads nothing past it.
   */
  const ancestry = async (
    block: Block,
    stop: (oldest: Block) => boolean,
    floor: number,
    expected = floor
  ) => {
    const walked = [block]
    const oldest = () => walked.at(-1)!
    while (!stop(oldest())) {
      const top = oldest().number - 1
      if (top < floor) return undefined
      const bottom = Math.max(top - HEADER_READS_AT_ONCE + 1, top >= expected ? expected : floor)
      const parents = await Promise.all(
        Array.from({ length: top - bottom + 1 }, (_, i) => timed(() => chain.block(top - i)))
      )
      for (const parent of parents) {
        if (stop(oldest())) break
        if (parent.hash !== oldest().parentHash)
          throw new Error('the chain source changed forks while the adapter walked back')
        walked.push(parent)
      }
    }
    return walked.toReversed()
  }

  /**
   * A chain that serves no tag for the kernel's finality refuses a kernel that has not started; one
   * that stops serving it while running raises one alarm, and no head moves until it serves it again.
   */
  const unservedFinality = () => {
    const reason = 'the chain does not serve the finality tag the kernel follows'
    if (!tip) return dispatch({ type: 'Refuse', reason })
    if (!unserved) dispatch({ type: 'Alarm', reason })
    unserved = true
  }

  /**
   * Delivers every block from the last one delivered to the chain's head, each linked to the one
   * before it, rolling back to the fork first. The first poll links the window above finality and
   * delivers only the blocks a simulation or fact may still be read at.
   * A head behind the tip rolls back to it unless the tip still exists. A fork older than the
   * retained blocks drops all evidence, since nothing proves which of it survived.
   */
  const followHead = async () => {
    const { head, finalized } = await timed(() => chain.latest())
    if (!finalized) return unservedFinality()
    unserved = false
    if (!(await anchorHolds())) return
    if (!tip) {
      const lag = head.number - finalized.number
      if (lag >= options.reorgDepth)
        dispatch({
          type: 'Refuse',
          reason: `the finalized block lags the head by ${lag} blocks, past the ${options.reorgDepth}-block reorg window`
        })
      const floor = Math.max(finalized.number, head.number - options.reorgDepth + 1, 0)
      const window = await ancestry(head, oldest => oldest.number <= floor, floor)
      const { maxSimLagBlocks, maxEvidenceAgeBlocks } = options.config
      const usable = head.number - Math.max(maxSimLagBlocks, maxEvidenceAgeBlocks)
      for (const block of window ?? [head])
        if (block.number < usable) retained.set(block.number, block)
        else deliverHead(block, finalized)
      return advanceAnchor(finalized)
    }
    if (head.number < tip.number) {
      const height = tip.number
      const ours = await timed(() => chain.block(height)).catch(() => undefined)
      if (ours?.hash === tip.hash) return refreshFinality(finalized)
    } else if (retained.get(head.number)?.hash === head.hash) return refreshFinality(finalized)
    if (knownHash(head.number) === head.hash) {
      rollBack(head.number)
      deliverHead(head, finalized)
      return advanceAnchor(finalized)
    }
    const oldest = Math.min(...retained.keys())
    const fresh = await ancestry(
      head,
      first => knownHash(first.number - 1) === first.parentHash,
      oldest,
      tip.number + 1
    )
    if (!fresh) return forgetAllEvidence('reorg deeper than the adapter retains')
    const fork = fresh[0]!.number - 1
    if (fork < tip.number) rollBack(fork)
    for (const block of fresh) deliverHead(block, finalized)
    advanceAnchor(finalized)
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

  /** Each poll starts one nonce further on, so a lookup that keeps failing never starves the rest. */
  let lookupTurn = 0
  /** Read after the poll's receipts, so a nonce one of them resolved is never looked up. */
  const readLookups = async (current: Current) => {
    const nonces = unidentifiedNonces(state())
    const first = lookupTurn++ % Math.max(nonces.length, 1)
    const turn = [...nonces.slice(first), ...nonces.slice(0, first)]
    for (const nonce of turn.slice(0, LOOKUPS_PER_POLL)) {
      const found = await attempt('nonceTx', () => chain.nonceTx(nonce))
      if (!current()) return
      if (!found) continue
      if (!(await deliverVouched(found.block, current, { type: 'NonceTx', nonce, ...found })))
        return
    }
  }

  /**
   * The account's nonces at `at`, and while the kernel holds none, its nonce at the chain's `safe`
   * block with the higher of the two pending counts; a chain that serves no `safe` tag is refused.
   */
  const readNonces = async (at: Block, current: Current) => {
    const nonce = await attempt('nonceAt', () => chain.nonceAt(at))
    if (!nonce || !current() || state().nextNonce !== undefined) return nonce
    const safe = await attempt('safe', () => chain.safe())
    if (safe === null)
      dispatch({
        type: 'Refuse',
        reason: 'the chain does not serve the safe tag, which a fresh enrollment waits on'
      })
    const atSafe =
      safe && current() ? await attempt('nonceAt', () => chain.nonceAt(safe)) : undefined
    return atSafe
      ? { ...nonce, safe: atSafe.latest, pending: Math.max(nonce.pending, atSafe.pending) }
      : nonce
  }

  /** Reads pinned to one tip; they stop as soon as that tip is no longer the one delivered. */
  const readAtTip = async () => {
    const at = tip
    if (!at) return
    const began = generation
    const current = () => tip === at && generation === began && !stopped()
    const pinned = { block: at.number, blockHash: at.hash }
    const nonce = await readNonces(at, current)
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
  const run = async () => {
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
    poll: (through: ChainPort) => {
      port = through
      void run()
    }
  }
}
