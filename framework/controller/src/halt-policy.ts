import type { GraphBuilder, Stream } from '@repo/engine'
import type { KernelRequest } from '@repo/kernel'

import { emitTo, every } from '@repo/engine'

/** One step of a halt policy: its next state, and the reason to halt when it calls for one. */
export type HaltPolicyStep<S> = Readonly<{ state: S; halt?: string }>

/**
 * A halt policy as a fold over `over`: the first step whose policy names a reason halts the kernel
 * into recovery with it, once. Its state replays with the graph and resets on restart.
 */
export const declareHaltPolicy = <T, S>(
  g: GraphBuilder,
  id: string,
  options: Readonly<{
    over: Stream<T>
    /** Where the halt goes: a node the kernel takes as one of its `requests`, which this fold writes. */
    requests: Stream<KernelRequest>
    initial: S
    applyInput: (state: S, value: T) => HaltPolicyStep<S>
  }>
) =>
  g.fold(id, {
    reads: { value: every(options.over) },
    emits: [options.requests],
    initial: { policy: options.initial, halted: undefined as string | undefined },
    applyInput: (halting, { value }) => {
      if (halting.halted !== undefined) return { state: halting }
      const next = options.applyInput(halting.policy, value)
      if (next.halt === undefined) return { state: { ...halting, policy: next.state } }
      return {
        state: { policy: next.state, halted: next.halt },
        emit: [emitTo(options.requests, { type: 'Halt', reason: next.halt })]
      }
    }
  })
