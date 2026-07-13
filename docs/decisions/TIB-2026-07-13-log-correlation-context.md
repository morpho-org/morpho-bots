# TIB-2026-07-13: cross-stage log correlation context

| Field      | Value                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **Status** | Proposed _(flips to Accepted at merge — the TIB lands in the correlation PR)_                           |
| **Date**   | 2026-07-13                                                                                              |
| **Author** | @hayden                                                                                                 |
| **Scope**  | Repo-wide (`@repo/evm-kit`, `apps/cli`, `apps/queued`, `apps/signer`, `@repo/pipeline`, both bot cores) |
| **Amends** | [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) — observability/logging clauses         |

---

## Context

The monolith→pipeline migration replaced one long-running process with a composed pipeline: a
source op, a transform op, `morpho-queued submit`, the per-chain `morpho-queued serve` daemon, and
the `morpho-signer` daemon. Each is a separate OS process with its own stderr stream, all
interleaved into one container log. The old monolith evaluated a position once, in a single call
stack, with one log stream — so "why didn't position X liquidate?" was answerable by reading down
one trace. The pipeline lost that: a single logical decision is now spread across up to five
processes, and an audit found the correlation trail broken in several places — the source dropped
non-actionable positions with no per-position line, queue terminal events logged only `nonce`/
`txHash` (not the pipeline id), signer rejections were fully orphaned, and no log line carried the
`bot`/`op`/`chainId` a reader needs to tell blue from midnight or one chain from another.

## Goals / Non-Goals

**Goals**

- Make a position's fate joinable across every stage from the logs alone.
- Establish, once, which context each stage binds and which key joins each stage boundary.

**Non-Goals**

- No wire-protocol change to the position/transaction records or the signer protocol (the join
  keys already ride existing fields).
- Not adding a distributed tracing system or per-request trace IDs beyond the existing pipeline id.
- Not reworking the bash entrypoint / supervision (deferred).

## Proposed Solution

### The join keys

- **`id`** — the pipeline correlation id `${domain}:${op}:${chainId}:${marketId}:${borrower}`
  (`packages/pipeline/src/liquidation-id.ts`). It rides `PositionRecord.id` → `TransactionRecord.id`
  → `QueuedTransaction.id` → the queue's pending `label` and the outcomes journal `id`. It is the
  primary join across **ops ↔ queue ↔ journal**.
- **`nonce` / `txHash`** — the join across **queue ↔ signer**. The signer never sees the pipeline
  id (its wire protocol is domain-agnostic and unchanged), so a signer log line joins to the queue
  by the prepared `nonce` (and, once broadcast, `txHash`).

### Stage-bound context (deliberately stage-specific — not a blanket "every line carries bot/op")

`createLogger(minLevel, base)` (`@repo/evm-kit`) stamps a set of base fields on every line it emits,
written so `level`/`event` are always last and can never be overwritten by base or per-call fields.
Each process binds only the context it legitimately owns:

| Stage                       | Bound base context     | Correlation on relevant lines                      |
| --------------------------- | ---------------------- | -------------------------------------------------- |
| Ops (source + transform)    | `{ bot, op, chainId }` | per-position `id` on every skip/emit decision      |
| `queued serve` / `submit`   | `{ chainId }`          | `id` on every ack + tx lifecycle line              |
| `signer`                    | _(none)_               | `nonce` (and `hash`) on `signer.signed`/`rejected` |
| Pre-config startup failures | _(best-effort)_        | emitted before a logger exists; no bound context   |

Concretely: the source ops emit a per-position `source.skip` (`not_liquidatable` at DEBUG,
`degenerate_plan` at INFO) carrying the `id` the record would have had; the transforms attach a
best-effort `id` to `invalid_record` skips (via `rawRecordId` in `@repo/pipeline`); the queue logs
`id` on `tx.sent`/`tx.confirmed`/`tx.reverted`/`tx.bumped`/`tx.dropped`/`tx.replace_failed`/
`tx.onblock_error` and on every ack, and emits `tx.signer_failed` (with `id`, `nonce`, and a `code`
distinguishing a policy rejection from a transport/internal failure) before a signer error
propagates; the signer adds `nonce` to `signer.rejected`.

## Considered Alternatives

### Alternative 1: Thread the pipeline `id` into the signer

Widen the signer wire protocol so a signer line carries the pipeline `id` directly.

**Why rejected:** the signer is intentionally domain-agnostic — it signs prepared transactions and
knows nothing of markets/borrowers. The queue already knows both the `id` and the `nonce`, so
correlating a signer rejection at the queue layer (`tx.signer_failed`) achieves the join with no
wire change and no leak of pipeline concepts into the signer.

### Alternative 2: Blanket base context on every process (bind bot/op everywhere)

**Why rejected:** the queue and signer are domain-agnostic daemons; stamping `bot`/`op` on their
lines would imply knowledge they do not (and should not) have. Context is bound per stage to what
that stage legitimately owns.

## Observability

This TIB _is_ an observability change. New/changed surfaces: the `source.skip` and
`tx.signer_failed` events; `id` added to the queue's terminal tx lifecycle lines and error acks;
`nonce` on `signer.rejected`; `bot`/`op`/`chainId` (ops) and `chainId` (queue/submit) base context
on every line. Any downstream log query that joined on the queue's old `label` field must move to
`id` (part of the pending Better Stack query migration).

## Future Considerations

- Finer-grained source-skip reasons (`healthy` / `no_debt` / `locked` / `gate_denied` /
  `lens_invalid`) if per-reason volume ever needs partitioning — deliberately deferred to keep this
  change log-plumbing only.
- A single end-to-end harness exercising the composed FIFO pipeline (today each stage is unit-tested
  in isolation).

## References

- [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md)
- [TIB-2026-07-10-signer-agent](./TIB-2026-07-10-signer-agent.md)
- [TIB-2026-07-11-queued-daemon](./TIB-2026-07-11-queued-daemon.md)
