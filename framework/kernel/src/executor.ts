import type { createKernel } from './kernel'
import type { LedgerStore } from './store'
import type {
  Command,
  FeeContext,
  Hash,
  KernelConfig,
  KernelEvent,
  KernelState,
  Payload,
  ReleasePayload,
  TxPayload,
  TypedPayload
} from './types'

/**
 * Handed to a signer or a send, which must call `mayAct()` immediately before it signs or acts on
 * the network, after any slow work of its own, and not proceed on `false`: the signal can fire late
 * when the event loop stalls, the kernel's checks cannot. A signature returned after a refusal is
 * discarded.
 */
export type EffectGuard = { signal: AbortSignal; mayAct(): boolean }

/** The head a simulation is pinned to: the kernel's own, while its header stands. */
export type SimulationHead = NonNullable<KernelState['head']>

type MaterializeCommand = Extract<Command, { type: 'materialize' }>
export type ReportCommand = Extract<Command, { type: 'report' }>

/**
 * What the kernel's commands do in the world. An effect must not act once its signal aborts; a
 * thrown broadcast or release is read as `unknown`.
 */
export type KernelEffects = {
  materialize(
    command: MaterializeCommand,
    signal: AbortSignal
  ): Promise<{ payload: Payload; witness?: unknown }>
  simulate(payload: TxPayload, at: SimulationHead, signal: AbortSignal): Promise<boolean>
  /** `fee` is the candidate's native spend ceiling; a replacement at the nonce has a higher `level`. */
  signTx(
    payload: TxPayload,
    candidate: Pick<FeeContext, 'nonce' | 'level'> & { fee: bigint },
    guard: EffectGuard
  ): Promise<{ hash: Hash; raw: string }>
  signTyped(payload: TypedPayload, guard: EffectGuard): Promise<string>
  broadcast(raw: string, guard: EffectGuard): Promise<'accepted' | 'rejected' | 'unknown'>
  release(payload: ReleasePayload, guard: EffectGuard): Promise<'ok' | 'unknown'>
}

/** How the executor reaches the kernel: it writes effect results and reads the kernel's current state. */
export type ExecutorPort = {
  signal: AbortSignal
  /** When the step that emitted the command began, on the runner's clock. */
  emittedAt: number
  now(): number
  write(event: KernelEvent): void
  /** Journals what a guard decided, so a handoff or a withhold can be explained afterwards. */
  note(verdict: GuardVerdict): void
  state(): KernelState
  stop(report: ReportCommand): void
}

type ExecutorOptions = {
  config: KernelConfig
  kernel: ReturnType<typeof createKernel>
  store: LedgerStore
  effects: KernelEffects
  effectTimeoutMs: number
  onError: (source: string, error: unknown) => void
}

export type GuardVerdict = {
  guard: 'sign' | 'handoff'
  request: number
  observedAt: number
  /** `act`, `closed`, `aborted`, `deadline`, or the kernel's reason to withhold. */
  verdict: string
}

/** Whether a simulation can start now: only at a head the kernel still holds the header of. */
const simulationHead = (state: KernelState) =>
  state.head !== undefined && state.headers[state.head.number] === state.head.hash
    ? state.head
    : undefined

/**
 * Runs the kernel's commands. Each settles when its work settles or the runner aborts it, except a
 * flush, which settles only once the store has, so a stop never abandons a write it handed off.
 */
export const createExecutor = (options: ExecutorOptions) => {
  const { effects, store, kernel } = options
  const fail = options.onError

  /** A send still waiting to act past the dispatch window is aborted, as SPEC §4.5 drops it. */
  const sendLimitMs = Math.min(options.effectTimeoutMs, options.config.maxDispatchLagMs)

  const run = <T>(
    port: ExecutorPort,
    request: number,
    work: (signal: AbortSignal) => Promise<T>,
    outcome: {
      done: (result: T) => KernelEvent
      failed: KernelEvent | (() => KernelEvent)
      limitMs?: number
      timedOut?: () => KernelEvent
    }
  ) =>
    new Promise<void>(settle => {
      if (port.signal.aborted) return settle()
      const controller = new AbortController()
      const abandon = () => {
        controller.abort()
        finish()
      }
      const deadline = setTimeout(() => {
        controller.abort()
        port.write(outcome.timedOut?.() ?? { type: 'TimedOut', request })
        finish()
      }, outcome.limitMs ?? options.effectTimeoutMs)
      const finish = () => {
        clearTimeout(deadline)
        port.signal.removeEventListener('abort', abandon)
        settle()
      }
      port.signal.addEventListener('abort', abandon)
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw controller.signal.reason
          return work(controller.signal)
        })
        .then(
          result => {
            if (!controller.signal.aborted) port.write(outcome.done(result))
          },
          (error: unknown) => {
            if (controller.signal.aborted) return
            fail('effect', error)
            const { failed } = outcome
            port.write(typeof failed === 'function' ? failed() : failed)
          }
        )
        .finally(finish)
    })

  /** Why the kernel, as it stands at `now`, withholds a send's plan, or undefined. */
  const withheld = (port: ExecutorPort, request: number, now: number) => {
    const state = port.state()
    const outstanding = state.outstanding[request]
    if (outstanding === undefined) return undefined
    const hash = outstanding.kind === 'broadcast' ? outstanding.hash : undefined
    return kernel.withholds(state, outstanding.plan, now, hash)
  }

  /**
   * Every answer is journaled with the time it observed; since journaling can halt the kernel, a yes
   * stands only if `judge` still says yes after it.
   */
  const journaledGuard = (
    port: ExecutorPort,
    note: Pick<GuardVerdict, 'guard' | 'request'>,
    signal: AbortSignal,
    judge: (observedAt: number) => string
  ): EffectGuard => {
    const journaled = () => {
      const observedAt = port.now()
      const verdict = judge(observedAt)
      port.note({ ...note, observedAt, verdict })
      return verdict
    }
    return {
      signal,
      mayAct: () => {
        if (journaled() !== 'act') return false
        if (judge(port.now()) === 'act') return true
        journaled()
        return false
      }
    }
  }

  /**
   * A send's guard, latched: the deadline runs from the step that emitted the command, and once the
   * send settles, aborts, or times out the guard never says yes again. Only a send whose guard never
   * said yes provably handed nothing off.
   */
  const latchFor = (port: ExecutorPort, request: number) => {
    const notAfter = port.emittedAt + sendLimitMs
    let closed = false
    let handedOff = false
    const judge = (signal: AbortSignal, observedAt: number) => {
      if (closed) return 'closed'
      if (signal.aborted) return 'aborted'
      if (observedAt > notAfter) return 'deadline'
      return withheld(port, request, observedAt) ?? 'act'
    }
    return {
      guard: (signal: AbortSignal): EffectGuard => {
        const guard = journaledGuard(port, { guard: 'handoff', request }, signal, observedAt =>
          judge(signal, observedAt)
        )
        return {
          signal,
          mayAct: () => {
            if (!guard.mayAct()) return false
            handedOff = true
            return true
          }
        }
      },
      close: () => {
        closed = true
        return handedOff
      }
    }
  }

  /** The signing guard: the kernel's checks at `Signed`, judged as the signer is about to sign. */
  const signGuard = (port: ExecutorPort, request: number, signal: AbortSignal) =>
    journaledGuard(port, { guard: 'sign', request }, signal, observedAt =>
      signal.aborted ? 'aborted' : (kernel.signRefusal(port.state(), request, observedAt) ?? 'act')
    )

  const sign = (port: ExecutorPort, command: Extract<Command, { type: 'sign' }>) => {
    const { request } = command
    if (!('nonce' in command)) {
      return run(
        port,
        request,
        signal => effects.signTyped(command.payload, signGuard(port, request, signal)),
        {
          done: signature => ({ type: 'Signed', request, signature }),
          failed: { type: 'EffectFailed', request }
        }
      )
    }
    const { payload, nonce, fee, feeLevel: level } = command
    const signTx = (signal: AbortSignal) =>
      effects.signTx(payload, { nonce, fee, level }, signGuard(port, request, signal))
    return run(port, request, signTx, {
      done: ({ hash, raw }) => ({ type: 'Signed', request, hash, raw }),
      failed: { type: 'EffectFailed', request }
    })
  }

  const flush = (port: ExecutorPort, command: Extract<Command, { type: 'flush' }>) =>
    Promise.resolve(command.ledger)
      .then(ledger => store.write(ledger))
      .then(
        () => port.write({ type: 'Flushed', seq: command.seq }),
        (error: unknown) => {
          fail('flush', error)
          port.write({ type: 'FlushFailed', seq: command.seq, reason: 'io' })
        }
      )

  const broadcast = (port: ExecutorPort, command: Extract<Command, { type: 'broadcast' }>) => {
    const { request, hash } = command
    const latch = latchFor(port, request)
    const ended = (outcome: 'unknown' | 'withheld'): KernelEvent => ({
      type: 'Broadcasted',
      request,
      hash,
      outcome: latch.close() ? outcome : 'withheld'
    })
    return run(port, request, signal => effects.broadcast(command.raw, latch.guard(signal)), {
      done: outcome => {
        latch.close()
        return { type: 'Broadcasted', request, hash, outcome }
      },
      failed: () => ended('unknown'),
      limitMs: sendLimitMs,
      timedOut: () => (latch.close() ? { type: 'TimedOut', request } : ended('withheld'))
    })
  }

  const release = (port: ExecutorPort, command: Extract<Command, { type: 'release' }>) => {
    const latch = latchFor(port, command.request)
    return run(
      port,
      command.request,
      signal => effects.release(command.payload, latch.guard(signal)),
      {
        done: outcome => {
          latch.close()
          return { type: 'Released', request: command.request, outcome }
        },
        failed: () => {
          latch.close()
          return { type: 'Released', request: command.request, outcome: 'unknown' }
        },
        limitMs: sendLimitMs
      }
    )
  }

  const execute = (command: Command, port: ExecutorPort): void | Promise<void> => {
    switch (command.type) {
      case 'materialize':
        return run(port, command.request, signal => effects.materialize(command, signal), {
          done: ({ payload, witness }) => ({
            type: 'Materialized',
            request: command.request,
            payload,
            witness
          }),
          failed: { type: 'EffectFailed', request: command.request }
        })
      case 'simulate': {
        const at = simulationHead(port.state())
        if (!at || !port.state().outstanding[command.request]) return
        return run(port, command.request, signal => effects.simulate(command.payload, at, signal), {
          done: ok => ({
            type: 'Simulated',
            request: command.request,
            ok,
            block: at.number,
            blockHash: at.hash
          }),
          failed: { type: 'EffectFailed', request: command.request }
        })
      }
      case 'sign':
        return sign(port, command)
      case 'flush':
        return flush(port, command)
      case 'broadcast':
        return broadcast(port, command)
      case 'release':
        return release(port, command)
      case 'findNonceTx':
      case 'notify':
        return
      case 'report':
        return port.stop(command)
    }
  }

  /** Work the kernel needs to withdraw or record exposure, which a flood of normal work never delays. */
  const recovery = (command: Command, state: KernelState) => {
    if (command.type === 'flush' || command.type === 'report') return true
    const intentId =
      'intentId' in command
        ? command.intentId
        : 'request' in command
          ? state.outstanding[command.request]?.plan
          : undefined
    return intentId !== undefined && state.plans[intentId]?.recovery !== undefined
  }

  return {
    execute,
    recovery,
    /** A simulation waits for a head whose header the kernel holds; every other command starts at once. */
    ready: (command: Command, state: KernelState) =>
      command.type !== 'simulate' || simulationHead(state) !== undefined
  }
}
