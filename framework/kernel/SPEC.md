# Kernel and commitment ledger: specification

Status: the specification of `@repo/kernel`, subordinate to ADR-2026-09-30, "A bot's key is used
only through its kernel", and ADR-2026-10-07, "Bot sources write levels and occurrences, and the
kernel authorizes against declared evidence".

- [`src/`](./src) is the executable form of this document: a deterministic reducer in plain
  TypeScript, `reduce(state, event) → { state, commands, activity }`. Where the prose and the reducer disagree,
  the reducer is wrong or the prose is. Either way it is a bug in this spec.
- [`test/`](./test) holds the adversarial event traces as vitest tests (§16).
- Run them with `pnpm --filter @repo/kernel run test` and `pnpm --filter @repo/kernel run typecheck`.

A kernel is one reducer per `(signing account, chain)`. It is the only code that signs, broadcasts, or
releases a signature, and the only code that changes the ledger. Everything handed to it is untrusted
except its own configuration, its validators, its own chain reads, and the effects that sign: `signTx`
and `signTyped` must sign exactly the payload they are given, at the given nonce and within the given
fee, and report the hash of the bytes they signed. The kernel does not re-check what they return.

## 1. Identities

| Identity         | Form                                                                   | Scope and lifetime                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| intent id        | `${key}#${runId}.${n}[.${task}]`, built by the controller; opaque here | Deduplicated while its plan is executing or compensating, and while any unretired entry or open nonce record names it. After that, the same id may be admitted again.                                                                                                                                                                                                                                                 |
| submission id    | caller-chosen, e.g. `saga/step`                                        | Bound to a digest of its first plan's steps, with hex lower-cased so the same bytes in another case match. Reserved in memory from admission, and durable in the same write as the plan's first exposure, or lazily at settlement for a plan that exposes nothing. A resubmission with the same digest returns the status and never re-executes while the reservation or record is held; any other digest is refused. |
| request          | monotonic integer, in memory                                           | Correlates one effect command with its result. A result whose request is no longer outstanding is discarded. Requests die with the process, and so do their results. Not the kernel ADR's _attempt_, which is durable.                                                                                                                                                                                                |
| transaction hash | the hash `signTx` reports for the bytes it signed                      | Correlates a broadcast, a receipt, and a nonce resolution across timeouts and restarts. The signing effect is trusted to make it the keccak of `raw` (above). Durable from the commit point.                                                                                                                                                                                                                          |
| commitment id    | `validatorId:protocolKey`, e.g. `midnight:<group>`                     | Chosen by the validator. Durable from `exposed` until retirement is final. Never admitted while the kernel holds it, retired ones included, so a retired id stays refused until the process restarts. After a restart it may be admitted again, which is conservative for Midnight because `consumed` is monotonic.                                                                                                   |

Ids index the ledger, so neither an intent id nor a submission id may name a property every object
inherits (`__proto__`, `constructor`, …). A submission naming one is refused, and so is a stored
ledger with such a key (§11.4). Ids must be strings and a fee ceiling a bigint, checked before any
arithmetic or indexing, so no id or fee ceiling can make admission throw. A refusal names a
malformed value by its type or a clipped string; a well-typed one it may quote whole. The event
envelope itself is not checked (§15). Blocks and times from outside (`basisBlock`, `notAfter`, `Tick.now`)
must be non-negative safe integers, since `NaN` passes every comparison. A malformed plan is
refused, a malformed `Advance` is answered `stalled` and leaves its plan parked unless its intent id
is itself malformed, which is ignored with an alarm, and a malformed clock reading is ignored with
an alarm ("refuses %s with a reason, never a throw", "refuses %s as an id, since ids index the ledger and must never name an inherited property", "refuses to start on a stored ledger whose record names an inherited property", "a block or time that is not a non-negative safe integer never passes a comparison", "refuses to start on a malformed clock reading (%s)").

A late _read_ result (simulation, materialization) is correlated by request and discarded when stale.
A late _exposure_ result (broadcast acknowledgement, receipt) is correlated by hash and applied while
its nonce record is unresolved; once the record is resolved or pruned it is ignored (§6).
A hash cannot correlate a request
made before a transaction exists, so reads get request ids. A request id cannot survive a restart, so
exposure gets hashes ("a simulation result answering a broadcast request is discarded, so the step is never sent again", "a timed-out broadcast is unknown, latches, and is reconciled when it lands late", "a replacement neutralizer that wins proves the original unable to run; a late receipt for it is ignored").

## 2. State

The complete type is `KernelState` in [`types.ts`](./src/types.ts). In one screen:

```
KernelState
  lifecycle      idle | starting | running | recovering(reason, since) | stopped(clean | unsafe | refused)
  head, finalized, headers[block] = hash          the kernel's own header chain (§8)
  chainNonce, nextNonce                           chain's latest count; next nonce the kernel allocates
  entries[id]    Entry                            the commitment ledger (§5)
  nonces[n]      NonceRecord                      per-nonce candidate records (§6)
  plans[id]      Plan                             in-memory plan progress (§4)
  outstanding[request] = { kind, plan, hash? }
  slot           request | -1 | undefined         the single exposure pipeline (§4.3)
  seq, ackedSeq  flush sequence number, and the highest one the runtime acknowledged as durable
  capacity[r], watermarks[r]                      hash-bound capacity reads and read-your-writes floors (§7)
  observations[fact]                              the facts plans rest on (§4.4)
  conflictMarks[id]                               our own effects' durable floors on conflict ids (§4.4)
  evidenceFloor                                   at least every conflict mark pruned (§4.4)
  releases[intentId] = { writes, after, restored? } what a release that may have left still owes (§4.4)
  submissions[sid]                                durable submission records (§11)
```

Reservations are **not** state. They are a pure function `holds(config, state)` over entries, nonce
records, and executing plans (§7). A reservation therefore cannot drift from what it reserves for,
cannot leak on a missed release, and is "rebuilt at startup" for free (review).

## 3. Events and commands

Every event is an input to `reduce`. Every command is an output the runtime executes and answers with
an event. The kernel never awaits anything (review).

| Source                 | Events                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lifecycle              | `Start{ledger (untrusted, §11.4), enrollment}`, `Stop`, `Halt{reason}`, `Tick{now}`                                                                                                                          |
| admission (engine)     | `Submit{plan}`, `Advance{intentId, stage, basisBlock, notAfter, evidence?}` (§4.3), `Affirm{ids}`, `Observed{observations}` (§4.4)                                                                           |
| untrusted plan builder | `Materialized{request, payload, witness}`                                                                                                                                                                    |
| effect operators       | `Simulated`, `Signed`, `EffectFailed`, `TimedOut`, `Flushed{seq}`, `FlushFailed{seq, reason}`, `Broadcasted{request?, hash, outcome}`, `Released`                                                            |
| kernel chain sources   | `Head`, `Header{number, hash}`, `Reorg{fork}`, `Receipt`, `NonceAt{latest, pending}`, `NonceTx{nonce, hash, …}`, `CommitmentObserved{id, consumed, neutralized}`, `Capacity{block, blockHash}`, `Seen{hash}` |

| Command                                                                   | Answered by                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `materialize{request, intentId, step, signatures, witness}`               | `Materialized`, or `EffectFailed`/`TimedOut`                              |
| `simulate{request, payload}`                                              | `Simulated{ok, block, blockHash}`                                         |
| `sign{request, payload}`, plus `{nonce, feeLevel, fee}` for a transaction | `Signed{hash, raw}` for a transaction, `Signed{signature}` for typed data |
| `flush{seq, ledger}`                                                      | `Flushed{seq}` after tmp → fsync → rename → fsync dir                     |
| `broadcast{request, hash, raw}`                                           | `Broadcasted{outcome}` or `TimedOut`                                      |
| `release{request, payload}`                                               | `Released{ok \| unknown}` or `TimedOut`                                   |
| `findNonceTx{nonce}`                                                      | `NonceTx`: the transaction the account sent at that nonce                 |
| `notify{intentId, notice, reason}`                                        | nothing; this is the engine's outcome feed                                |
| `report{outcome, reason, open}`                                           | nothing; this is the terminal stop result                                 |

The kernel's chain adapter polls the chain on its own, never through the bot's sources, so a slow
strategy read never stalls a receipt, a nonce read, or a recovery observation. The runtime polls
`pollSet(state)` every poll: receipts for every unresolved candidate, and observations for every
unretired commitment (untested). Every chain read carries `(block, blockHash)` and is ignored unless that hash
matches the kernel's header at that height (§8)
("a capacity read that arrives late from an orphaned block is ignored").

## 4. Plans

### 4.1 Admission

`Submit` is one atomic transition: it admits the plan with its reservation, or refuses and leaves no
trace but the observations it carried, which are applied before admission (§4.4). A plan that names
one it `supersedes` is judged with that plan set aside, on a copy; the
superseded plan fails only once this one is admitted, never past its commit point, and a
risk-reducing plan is superseded only by another. In order:

1. **Idempotency.** A submission id held by an active plan or a durable record, with the same step
   digest, returns `notify(known, status)`. With a different digest it is refused as a conflict. An
   intent id already executing, or named by an unresolved entry or nonce record, is refused as a
   duplicate ("a second submission with the same id before any commit is answered, not executed", "after a restart a conflicting resubmission of an exposed submission is refused", "an intent id named by an unretired entry is refused as a duplicate after its plan settles").
2. **Lifecycle.** Refused unless the kernel is `starting`, `running`, or `recovering`. The policy
   mode is `normal` only when the kernel is `running` and not latched. Otherwise it is `recovery`
   ("answers a submission before it starts and after it stops, so no answer is left owed", "a timed-out broadcast is unknown, latches, and is reconciled when it lands late").
3. **Reading.** Every step whose payload is present is authorized (§4.2). Its reading contributes
   `creates`, `consumes`, and `retires`. A step's `exposes` must name commitments created by an
   earlier payload-bearing step of the same plan. `retires` must name owned entries that are `exposed`, `live`,
   or `revoking`. A created id must be new to the ledger ("a step that exposes a commitment no earlier step signed refuses the whole plan, so its earlier ratification never leaves", "a step calling itself compensation for a commitment the kernel does not own is refused", "a commitment id the ledger already holds is never admitted again, so a live entry is never overwritten").
4. **Envelope.** The union of `creates` and the sum of `consumes` from those readings is the plan's
   _envelope_. The plan cannot widen it later (§4.2)
   ("a dependent step that grows the cap of a still-intended commitment is refused by the cap check").
5. **Risk.** A plan is _risk-increasing_ if its envelope creates or consumes anything, _risk-reducing_
   if it is not and some step retires an owned entry (its other steps may be neutral), and _neutral_
   otherwise (a liquidation). **Fees are not
   exposure**: they are reserved apart under `feeReserve` and bounded only by the fee policy, so a
   plan whose only cost is its fee is neutral. Only risk-reducing plans and the kernel's own recovery
   plans run outside `running`, or while latched ("while latched, a neutral plan of dependent steps is refused at admission and leaves no trace")
   ("a plan whose only cost is its fee": "is still new work: refused while the kernel is latched or recovering").
6. **Conflicts.** A plan declares `conflicts`, opaque semantic ids it reads and writes. It is refused
   while an executing plan's writes meet its reads or writes, or its writes meet that plan's. An id
   must be a string of 1 to 256 UTF-16 code units with no C0 control or DEL character that names no
   inherited property, since the ledger keeps a mark per id (§4.4); anything else refuses the plan
   ("refuses a plan that reads an id an executing plan writes, and the reverse", "refuses at admission a conflict id that is %s").
7. **Capacity.** Need = envelope resources + consumes + `feeReserve` per transaction step. Each must
   fit `available(r)` (§7). An observed resource must also have a capacity reading at or after its
   watermark ("an admission that would exceed a cap is refused atomically", "a risk-increasing admission waits for a capacity read at or after our last final effect on it").
8. **Evidence.** The facts the plan rests on must pass the evidence check of §4.4
   ("admits a plan whose facts arrive with it, and refuses one whose fact it never saw").
9. **Effect.** The plan is recorded, an `intended` entry is created per envelope commitment (recording
   the id and version of the validator that read it), and `admitted` is notified ("a liquidation is simulated, flushed, broadcast, and settled on inclusion; its fee reserve ends on resolution", "an upgrade that drops the validator version an entry was recorded under refuses to start").

The plan's own fields (`intentId`, `steps`, `notAfter`, `basisBlock`) carry no amounts, targets, or
risk class. Everything funds-relevant comes from validator readings. The one exception is optional and
can only tighten: `maxSpendWei`, a fee ceiling for the plan's own candidates (§6, "Fees"). A
non-positive ceiling is refused, and a submission id is bound to it as well as to the steps
("a non-positive plan ceiling is refused at admission and reserves nothing", "a submission id is bound to its fee ceiling as well as its steps").

### 4.2 Authorization of one materialized action

`authorize(payload, witness, mode)` is pure. It returns a validator reading or a refusal:

1. Calldata that is not `0x` and whole bytes of hex is refused. A kernel-native nonce fill (`to` =
   the account in any letter case, zero value, empty calldata) is allowed in `recovery` mode only,
   and reads as nothing. Any other transaction to the account is refused. A fill reads as nothing
   only on an account with no code: under EIP-7702 a delegated account runs its code on every call,
   so `Start` carries the account's code and the kernel refuses to start on one that has any
   ("refuses calldata that is %s before anything is signed", "a nonce fill submitted while running is refused, since it is allowed in recovery mode only", "treats the account spelled in another case as the account", "refuses to start on an account that has code, since a nonce fill would run it").
2. Exactly one validator must claim the payload (by `to` for transactions, by the domain's
   `verifyingContract` for typed data, by `channel` for releases). Typed data carries its whole
   EIP-712 form (domain, types, primary type, message), so a validator binds the chain and the types,
   not just the message. None or several means refusal. **An action no validator
   recognizes is refused**, so a liquidator's kernel cannot sign typed data at all ("typed data no validator claims is refused, so a liquidator cannot sign an offer", "typed data whose domain names another chain is refused before anything is signed", "typed data with %s is refused before anything is signed").
3. The validator reads the payload plus its witness (§9). A refusal or a throw is a refusal.
   So is a reading its act cannot record (§4.5): only a transaction may retire or consume, and a
   release may not create ("a validator that throws in claims or confirm is contained", "a validator that throws is a refusal, not a crash", "refuses a %s step whose reading %s").
4. Policy. In `normal` mode the transaction target must be in `policy.targets`, in any letter case. In
   `recovery` mode it must be in `policy.recoveryTargets`, and the reading must create, expose, and consume nothing.
   The kernel checks only the target. The rest of today's `evaluatePolicy` (chain id, value,
   selector, gas, spend, size, multicall) is not checked here: the signer the `sign` effect calls
   must apply it ("admits a target the policy spells in another letter case", "withdraws a
   commitment whose creating target the current policy no longer allows", "the recovery policy refuses a stored neutralizer whose reading also creates exposure").

A dependent step (no payload at admission) is materialized by the untrusted builder and then
authorized the same way: its payload kind must match its step kind, and anything it retires must be
owned. It must also pass the **envelope fit**. Every created id must be in the envelope, still
`intended` (a builder cannot re-create, and so demote, a commitment already signed or out), with cap,
expiry, and each resource no greater than admitted (three distinct refusals: outside the envelope,
already out, beyond its admitted bounds). Its `consumes` must fit what is **unallocated**: the
envelope minus what is committed and minus what later known steps were admitted with, so a dependent
step can never spend a later step's allowance. Its `exposes` must name this plan's entries. At every
commit point the kernel re-checks that cumulative committed consumption stays within the envelope. A plan can therefore neither introduce an
unreserved commitment later nor understate one at admission. The reservation is sized from what the
validator read, and anything later must fit inside it ("a dependent step cannot re-create a commitment an earlier step already signed", "a builder that re-materializes a live commitment cannot demote or delete it", "a dependent step that grows the cap of a still-intended commitment is refused by the cap check", "a dependent step cannot spend the allowance a later known step was admitted with", "a step whose kind disagrees with its payload is refused, so a transaction is never signed or released outside the slot").

### 4.3 Execution states

A plan's `status` is `executing → settled | abandoned | compensating → compensated | failed`. While
executing, the current step `cursor` is in one `phase`:

| Phase              | Entered when                                                                     | Leaves on                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`            | a step starts                                                                    | at a stage boundary, `awaiting-advance` before any check; else authorization re-check (§4.4), then `materialize`, `simulate`, `sign` (typed data), or `await-slot` (release)                                                                                                          |
| `materialize`      | step payload missing                                                             | `Materialized` → authorize + envelope fit → `ready`; refusal or timeout → fail                                                                                                                                                                                                        |
| `awaiting-advance` | a step follows an included transaction or a release (a stage boundary)           | `Advance{stage = cursor}` admitted on the next stage's own evidence, read at or after `lastInclusion` → `ready`; a refused one (`stalled`) leaves it parked; expiry, a halt or supersession → fail                                                                                    |
| `simulate`         | transaction step                                                                 | `Simulated{ok}` → `await-slot`, recording `(block, blockHash)`; not ok or timeout → fail                                                                                                                                                                                              |
| `await-slot`       | simulation passed, or a release step                                             | slot free, recovery plans first: re-check; if the simulation is stale go back to `ready`; else pick the nonce and emit `sign` (tx) or commit (release)                                                                                                                                |
| `sign`             | typed data: from `ready`. transaction: holds the slot                            | typed: `Signed` → entries `signed`, next step. tx: `Signed` → final check (§4.4) → **commit** (§4.5), or back to `ready` if the simulation aged, or fail. A signing timeout or failure frees the slot and fails the plan                                                              |
| `commit`           | commit point passed; flush emitted, even when the commit changed nothing durable | `Flushed{seq ≥ flushSeq}` → dispatch check (§4.5) → emit `broadcast`/`release` → `expose`, or withhold and fail. `FlushFailed` → a transaction candidate is kept as `rejected`, a release's plan fails; the kernel enters recovery, or stops unsafe if already recovering or `fenced` |
| `expose`           | exposure act dispatched                                                          | `Broadcasted` or `TimedOut` (→ candidate `unknown`) → `include`. `Released`/timeout → next step                                                                                                                                                                                       |
| `include`          | transaction dispatched                                                           | nonce resolution with this candidate executed and validator-confirmed → `lastInclusion`, next step. Resolved to anything else → fail                                                                                                                                                  |

`fail(plan)` cancels its outstanding read requests and frees a slot held before the commit point. Any
late result for them is then discarded. Then:

- **Nothing exposed**: its `intended` and `signed` entries are deleted, its reservation disappears
  with them, and `abandoned` is notified ("a simulation failing before exposure abandons the plan and releases its reservation", "names an entry dropped when its plan fails before exposure").
- **Something exposed**: unexposed entries are deleted, and exposed or live ones are flagged
  `compensate`. The recovery controller neutralizes them (§10). The plan is `compensated` only when
  every one of its entries is `retired` (so at finality) and no nonce record still holds a candidate
  of this plan or one that neutralizes its entries (so nothing that could recreate or undo the
  exposure can still execute). A `revoking` entry or a provisional cancel is not compensation. The
  plan is `failed` if any entry is stuck; the kernel is then already recovering ("a later step failing after an earlier one exposed compensates the exposure", "compensation is complete only when the cancellation is final and its nonce resolved", "compensation that cannot complete keeps the exposure and ends in recovery and an unsafe stop").

A plan that finishes its last step is `settled`: every transaction step was included, every `sign`
step signed, and every release answered, `unknown` included. It does not mean inclusion is final; a consumer that needs finality (a saga gate) waits for the nonce records to be
pruned ("a liquidation is simulated, flushed, broadcast, and settled on inclusion; its fee reserve ends on resolution", "a settled notice names every included step, even one whose nonce record was pruned at finality"). `intended` and `signed` entries it never carried
out of the process (a signature it chose not to publish) are deleted (untested).

There is **one exposure pipeline per account** (the slot). It is held from `sign` of a transaction
through the broadcast result, or from commit through a release result. Simulations and typed-data
signatures run concurrently. Many transactions may be pending onchain at once ("a signing %s frees the exposure slot for the next plan and for recovery", "admits plans on disjoint ids side by side, both sent before either receipt").

### 4.4 The pre-action check, and what an authorization is

An authorization to perform one exposure act is the conjunction, evaluated at the `Signed` event
(transactions) or at slot acquisition (releases), of:

| Element            | Bound to                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| exact action bytes | the payload that was authorized, simulated, and signed. The hash is what the flush records                                                          |
| validator reading  | computed from those bytes and their witness; it fits the envelope                                                                                   |
| policy             | the payload re-authorized under the mode in force _now_, at slot acquisition and again at `Signed`                                                  |
| decision validity  | `now < notAfter` while the current step is uncommitted                                                                                              |
| fresh basis        | after a stage boundary: the advance's basis and facts `≥ lastInclusion`, and simulation block ≥ that inclusion                                      |
| own effects        | `basisBlock` and every fact's block `≥ watermarks[r]` for every resource the plan consumes or commits, at admission, slot acquisition, and `Signed` |
| evidence           | every fact the stage rests on, as the kernel last observed it (below), and `now < notAfter`                                                         |
| simulation         | `ok` at a canonical block no older than `head − maxSimLagBlocks`                                                                                    |
| reservation        | held by construction: the plan's envelope is in `holds` from admission                                                                              |
| nonce              | the next unallocated nonce, or a still-open record for a replacement                                                                                |

Supersession, expiry, and a stop or halt that forbids the plan fail it at that event and cancel its
attempts, and the late result is then discarded by request. Before its commit, a changed fact fails
it at the next check that judges evidence (below). The final check at `Signed` catches what no event
reports against this plan:

- a halt that leaves a risk-reducing plan running while its _current_ step is neutral, so the
  step's payload now fails the recovery policy. The plan fails, as in the trace "a halt that lands
  while a later step is being signed";
- the simulation aging past the lag bound while the signer ran. The step is re-simulated
  ("a simulation that ages past the lag bound while signing is redone, and the signed bytes never leave").

**Evidence.** A plan names the facts its decision rests on, each with the version it was decided on
and the block and hash of this chain it was read at. `Submit` and `Advance` refuse a fact that names
no block; a candidate's recorded authority without one still loads, since it authorizes nothing
again. For registered fact nodes, `factId(node, key)` is unambiguous: a registered node id may not
contain `/`, while a key may, and the first `/` separates them ("refuses a fact node holding / through
%s", "both attach paths route a key holding / to its registered fact node"). `factId` itself is an
exported formatter and does not validate arbitrary strings. The host's `observe` fold hands the
kernel the current observation of every fact a plan names with the plan, and every later change as
`Observed`, while any plan rests on it. A fact is refused when it is read below the evidence floor,
unobserved, unknown or failed, at another version, read at a block the kernel holds no header for or
has orphaned, or read before the conflict mark of any id the plan declares: the block of the last
inclusion, or the head after the last release, of our own plan writing that id ("refuses a fact that is unknown or failed, or no longer at the version decided on", "refuses a fact read at a block it does not hold, or on a branch that was orphaned", "refuses evidence on a conflict id read before our own effect on it was included", "stalls a stage whose evidence names no block", "loads a ledger whose recorded authority names no block, since it authorizes nothing again").

The evidence floor is `max(evidenceFloor, head − maxEvidenceAgeBlocks, 0)`, and a fact below it is
refused as `evidence_too_old`. `maxEvidenceAgeBlocks` (K) is required per bot and refused when it is
not an integer in [0, 2³²]; it covers the bot's slowest fact source plus its preparation time,
and how far a chain source after a restart may lag the one the crashed run followed. A mark at or
below the floor can refuse nothing, since every admitted fact is read at or above it, so it is
pruned before the flush, and `evidenceFloor` is raised to it in the same durable write. Neither a
reorg that lowers the head nor a restart then lowers the floor below a pruned mark; with nothing
pruned the floor may fall after a restart, and every mark is still on disk. Headers stay held down
to `head − K`, below finality too, so a fact inside the bound is not refused for a dropped header.
An action that may have taken effect owes its marks durably until they are raised. A candidate
records the ids its plan writes, so whichever run sees it land marks them at its block, again at a
later block if a reorg re-lands it, and after a restart that dropped its plan. A release records
them in the flush that gates it, with one past the highest head seen while it may still leave,
refreshed durably at each head; once it can no longer leave (answered, failed, or withheld) they
are marked at the higher of that and the current head plus one. A release restored from the ledger
is `restored`, and settles at the first head `h` after the restart at `max(after, h + 1) + K + 1`: the
crashed run may have seen heads it never made durable, but none more than K above `h`, or more than
K above its durable `after`. Either bound alone puts the mark past every head the
release could have left at, so a restart onto a source lagging further than K still marks it high
enough, and evidence on its writes is refused until then.
The rule binds a plan **until its nonce is committed**. The nonce picked at slot acquisition is
provisional until then, so the rule is still checked when the signer is invoked and at `Signed`.
After the commit, a neutral plan goes and the chain arbitrates, while a risk-increasing plan is still
withheld for its evidence and `notAfter`. Risk-reducing and recovery plans are never refused for the
validity of their facts; one that names evidence still ends at the deadline its evidence lowers
`notAfter` to ("ends a risk-reducing plan at the deadline its evidence fell to"). The check runs at admission, slot acquisition, `Signed`, and through the
executor's guards immediately before the signer is invoked and before the network handoff. The
candidate's record carries the evidence and decision record it was authorized on, so the flush that
gates the send also records why.

An observation of a present or absent fact may carry its read's `expiry`, in the kernel's clock. One
that is not a non-negative safe integer makes the fact failed, with an alarm. Wherever the kernel
takes in observations (`Observed`, and the seeds of `Submit` and `Advance`), it lowers the
`notAfter` of every executing plan whose current evidence names the fact to that expiry, and a new
plan or stage starts from the earliest of its own `notAfter` and the expiries the kernel holds for
its facts. Within a stage a deadline never rises, whether an expiry is extended or removed; an
accepted `Advance` replaces it. Lowering a deadline refuses nothing by itself: the checks above
judge it, with the same post-commit, risk-reducing and recovery rules. The one exception is a plan
**resting** on its stage: its step is being included (`include`), or it is parked and not yet past
its deadline. No step of it is judged on that evidence again, so while every fact it rests on reads
again at the version it was decided on, its deadline becomes the earliest of their latest
expiries, judged once the whole batch is in. A changed or unavailable reading never extends it, nor
does a batch that reads one of its facts twice, so the plan ends at its deadline
unless the bot supersedes it first, and a parked plan already past its deadline is never revived
("reads a fact as failed, and keeps its deadline, when its expiry is %s", "falls to an expiry that appears on an unchanged fact, and the act is refused at it", "never rises within a stage, whether the expiry is extended or removed", "falls for every executing plan a later submission seeds the same fact for", "follows its facts read again unchanged, and rebroadcasts while they hold", "is never extended by an equal read %s one that no longer holds", "stays past its deadline once there, whatever a later read says").

**Stages.** A step after an included transaction or a release begins a new stage. The plan parks
there before anything judges it, so a stage is never refused on an earlier stage's evidence, which
its own effect may have changed, and it ends at its finished stage's `notAfter` unless an `Advance`
moves it first: it brings the stage's evidence, `notAfter` and basis, and passes the lifecycle,
`decisionRefusal`, own-effect and
evidence checks; every evidence fact's block, and the basis itself, must be at or after
`lastInclusion` (after a release, the head at the release plus one). The reservation the plan was
admitted with carries across: an advance never re-checks free capacity, and nothing of it is freed
between stages. A restart restores entries and candidates but no plan, so no stage resumes and
capacity for uncommitted stages is not held. A parked plan may be superseded; when the superseding
plan's next step retires the superseded plan's entries, recovery leaves them to it ("survives its own ratification, and publishes only on fresh publication-stage evidence", "refuses an advance for a stage the plan is not parked at", "holds a later stage capacity while parked, and spends it on advance without re-checking", "keeps only what was committed across a restart, with no authority to continue", "never publishes once the decision moves past its band, and the superseding cancel is the compensation").

Recovery and risk-reducing plans have no stages, and recovery has no deadline. They still pass
policy (recovery mode), the validator, and simulation ("never refuses a recovery plan at the signer for a deadline its evidence fell to", "never withholds a recovery plan at handoff for a deadline its evidence fell to").

### 4.5 The commit point

The irreversible acts are broadcast and release. A signature that stays in the process exposes
nothing (§5, `signed`), yet every payload passes authorization (§4.2) before it is signed, so the
kernel never produces a signature it would refuse to expose ("after a typed signature but before its release: the signature died with the process", "typed data whose domain names another chain is refused before anything is signed").

The commit point is the reducer transition at `Signed` (transaction) or slot acquisition (release)
that passes §4.4. In that one transition:

1. For a transaction: append a candidate `{hash, raw, payload, kind, intentId, step, creates, exposes,
retires, consumes, feeLevel, sent: unsent}` to the nonce record, and advance `nextNonce` if the
   nonce was fresh ("a replacement is recorded at the nonce, level and fee it was signed at", "after the flush: the candidate reads back with the evidence and decision it went on, and no authority").
2. Created commitments become `exposed` and record this hash as a creator. Carried commitments move
   `signed → exposed`; ones this plan already released stay as they are. Retired ones move to
   `revoking`, recording the neutralizing hash and the prior state ("ecrecover quoting signs in memory, exposes at the publish commit, and goes live on inclusion", "a reorg that removes a cancel reopens it; the reservation was never released").
3. Check first that every carried signature was produced by this plan, every carried commitment is
   this plan's and `signed`, `exposed`, or `live`, every created one is this plan's and still
   `intended` or `signed`, and every retired one is owned. Otherwise the signed bytes are discarded
   and the plan fails ("a publish carrying a signature this plan never produced is refused at the commit point").
4. Record the submission as `exposed` ("a crash after the first exposure keeps the submission record, so resubmission is refused").
5. Emit `flush` with the new durable projection, and record `committedAt = now` ("after the commit point but before the flush is written: nothing left the process", "a flush acknowledged after the dispatch bound withholds the act").

**The dispatch check.** The act is dispatched only on its `Flushed`, and only if, at that event, the
plan still passes `stillAuthorized` and re-authorization under the current policy, its simulation
block is still canonical, and `now − committedAt ≤ maxDispatchLagMs`. Otherwise the act is
**withheld**: the candidate is marked `withheld`, nothing is sent, and the plan fails into
compensation. The durable record already says "possibly sent", which is conservative. The withheld
nonce is then filled like a rejected one, and exposure recorded for a withheld release is
neutralized. A withheld **neutralizer** never left the process, so the entries it would have retired
go back to their prior state at once. The recovery controller then neutralizes them again, and a
withheld recovery candidate no longer counts as contesting its nonce (`nonces.test.ts`,
"a withheld recovery neutralizer hands its entry back, and recovery occupies the nonce again", "a fact that changes during the flush withholds a risk-increasing broadcast; the recorded nonce is filled", "dispatch withholds an act whose simulation block the kernel knows was orphaned").

This bounds the window in which the kernel knowingly sends obsolete bytes to the time between the
dispatch check and the network call itself, which is one reducer transition plus the runtime's queue.
It does not bound how long signed bytes remain _executable_, which only chain evidence does.
`maxDispatchLagMs` covers fsync stalls and delayed acknowledgements. It
bounds how late the **check** may run, not when the bytes reach the network. **The runtime must
bound its send queue**: the executor bounds a send by the smaller of `effectTimeoutMs` and
`maxDispatchLagMs`, and a send that fails or times out before its guard permitted the handoff is
reported `withheld`, after it `unknown`. It must deliver `Tick` often enough that
`now` is current at each `Flushed`. Simulation _age_ is deliberately not re-checked at dispatch: an
fsync that outlasts a block would otherwise force a withhold and a fill on every busy chain, and the
time bound caps that exposure instead. Simulation _canonicality_ is re-checked: a simulation whose
block the kernel's own header chain has orphaned is evidence the kernel holds, not a staleness
estimate (`reorg.test.ts`). Traces: "a fact that changes during the flush withholds a risk-increasing
broadcast", "a flush acknowledged after the dispatch bound", and the matrix "an act
between its committed nonce and its handoff".

## 5. The commitment ledger

An entry is created at admission and deleted only while nothing of it can be exposed: when its plan
is abandoned, or as an `intended` or `signed` entry its plan settles or fails without carrying. Its
states:

| State      | Meaning                                                                | Durable | Reserved | On crash recovery                                                                                                          |
| ---------- | ---------------------------------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `intended` | admitted; no signature exists                                          | no      | yes      | gone: nothing was signed                                                                                                   |
| `signed`   | a signature exists in this process only                                | no      | yes      | gone: a signature leaves only through a commit point                                                                       |
| `exposed`  | the commit point for an act that creates or carries it has passed      | yes     | yes      | treated as live; observed before `running`; latched if its act is unknown                                                  |
| `live`     | a creating or carrying transaction executed (provisionally or finally) | yes     | yes      | adopted if current policy and caps allow (§10, "Adoption at start"), observed before `running`, then affirmed or withdrawn |
| `revoking` | a neutralizer for it has passed its commit point                       | yes     | yes      | the neutralizer candidate is reloaded and re-sent from stored bytes; if it lost, re-neutralized                            |
| `retired`  | positive evidence at finality                                          | pruned  | no       | if the pruning flush was lost, re-learned from the chain                                                                   |

| From                  | Event (evaluated each pass)                                                             | To          |
| --------------------- | --------------------------------------------------------------------------------------- | ----------- |
| —                     | admission reads a `creates`                                                             | `intended`  |
| `intended`            | typed-data `Signed` for its sign step                                                   | `signed`    |
| `intended`/`signed`   | commit point of a transaction that creates it, or of an act that carries it             | `exposed`   |
| `intended`/`signed`   | plan abandoned, settled without carrying it, or failed                                  | deleted     |
| `exposed`             | a creator or carrier candidate wins its nonce with a successful receipt                 | `live`      |
| `live`                | the block that made it live is reorged away                                             | `exposed`   |
| `exposed`/`live`      | commit point of a neutralizer that retires it                                           | `revoking`  |
| `revoking`            | its neutralizer resolves not executed (lost, reverted, unconfirmed, or external winner) | prior state |
| `revoking`            | any of our neutralizers for it resolves executed **at a final block**                   | `retired`   |
| any open              | final observation: `neutralized`, or `consumed ≥ cap`                                   | `retired`   |
| any open              | final block timestamp > the commitment's enforceable expiry                             | `retired`   |
| `exposed` (inclusion) | every creator candidate is final and lost or reverted                                   | `retired`   |

Rules that hold across the table:

- **Absence never retires.** A missing receipt, an empty book, or a nonce the kernel cannot attribute
  never moves an entry toward `retired` ("a nonce consumed by a transaction the kernel cannot identify stays unresolved and held", "a restart that never sees its offer observed still withdraws it once affirmation lapses").
- **Provisional evidence only makes the kernel more conservative.** A provisional neutralizer win
  records `retireEvidence` and releases nothing. A provisional loss hands the entry back to be
  re-neutralized, which costs gas and never safety. A provisional fill changes nothing (`consumedFinal`
  moves only at finality) ("a reorg that removes a cancel reopens it; the reservation was never released", "a provisional fill makes nothing available; a reorg of it is harmless; the final fill releases").
- **`exposure` decides what a failed carrier means.** An `inclusion` commitment (Setter ratification)
  exists only if its creating transaction executes, so its creators' final failure proves it never
  existed ("a ratification that reverts proves its commitment never existed: it retires at finality
  with nothing to cancel"). A `broadcast` commitment (an Ecrecover signature) exists once the payload
  leaves, whether or not the carrying transaction mines. Its carrier failing proves nothing, and only
  neutralization, consumption, or expiry retires it (untested).
- **Confirmation cuts both ways conservatively.** A successful receipt without the validator's
  expected transition (a missing `SetIsRootRatified` log) counts as _having created_ the commitment,
  because absence never retires. It counts as _not having neutralized_ one, and it fails the plan's
  step. The kernel raises an alarm ("a success without its expected log never proves the commitment absent").
- **Revocation needs no fresh decision input.** It uses the stored neutralizer, re-authorized by the
  current validator and recovery policy (§12, "policy changes during recovery")
  ("after a neutralizer is flushed but before it is sent: the stored bytes are re-sent, not re-derived", "recovery after a config change removed the market cancels from the stored neutralizer", "the recovery policy refuses a stored neutralizer whose reading also creates exposure").
- **Three lifetimes are distinct**: a plan's `notAfter` (its deadline, which is its current
  stage's evidence deadline, or a withdrawal's own expiry since it rests on no fact: a submission
  or `Advance` past it is refused, no uncommitted step goes past it, a risk-increasing step is
  withheld past it throughout, a plan that parks past it ends, an equal re-read extends it only
  while the plan rests (§4.4), and the kernel rebroadcasts an
  `unknown` candidate only before it, §4.4), the
  entry's `expiry` (enforceable validity, in chain time), and the revocation obligation (§10). A
  plan has no execution horizon of its own ("an intent submitted past its deadline is never signed", "a commitment past its enforceable expiry at a final block retires without any action", "an expired plan is not rebroadcast while latched", "ends a parked plan whose finished stage deadline an observation lowered past, on its next advance").

## 6. Nonces, the latch, and resolution

A **nonce record** exists from the first commit point at that nonce until its resolution is final.
Its candidates are every transaction the kernel signed and committed at that nonce: the original, fee
or payload replacements, recovery neutralizers, and fills. Each candidate is durable with its raw
bytes and its reading ("after the flush: the candidate reads back with the evidence and decision it went on, and no authority", "drops a settled plan once its nonce resolves, and keeps it while the record is open").

**Send status.** A candidate's `sent` is `unsent → accepted | rejected | unknown | withheld`.
`unknown` means the kernel holds no acknowledgement it trusts and has not seen the candidate in the
pool. Only `Seen` or an `accepted` acknowledgement moves `unknown → accepted`. A later rejection of an `unknown` candidate is
ignored, because a rebroadcast answered "already known" or "nonce too low" is not evidence. A
broadcast attempt records the hash it sent, so a late timeout marks that candidate and no other. On
reload, every candidate that is not `rejected` or `withheld` becomes `unknown`: the process cannot
know whether the pool still holds it ("a timed-out broadcast is unknown, latches, and is reconciled when it lands late", "a latch never clears on time or on a late rejection: past its bound the kernel recovers", "a late timeout of a rebroadcast cannot mark an unflushed candidate as sent", "after the flush is written but before the broadcast: exposure is assumed, latched, and neutralized").

**Foreign records.** A `NonceAt` while running whose `latest` or `pending` count is beyond `nextNonce`
proves the account sent something the kernel never recorded. The kernel records every nonce in that
range as a durable _foreign_ record with no candidates, advances `nextNonce` past it, and enters
recovery. A foreign record latches, holds a fee reserve, blocks a clean stop, and is never occupied
by recovery (the kernel does not compete with a transaction it cannot read). It resolves only by
`NonceTx` identification at finality, or the stop is unsafe (trace: "an unrecorded pending
transaction is an open obligation"). A foreign record always means recovery. Discovering one enters
recovery, and reloading one at startup restores it: `starting` goes to `recovering` rather than
`running`. So the recovery bound, not the latch bound, is what ends an unidentified foreign
transaction in an unsafe stop, however many restarts intervene (`restart.test.ts`).

**Resolution** is `{block, blockHash, winner: hash | null, success, confirmed}`:

- from a `Receipt` for one of its candidates at a canonical block
  ("a restart resolves a transaction mined before it, once the block is vouched for"), or
- from `NonceTx`, the positive identification of the transaction the account sent at that nonce (the
  runtime bisects `getTransactionCount` by block hash and reads that block's body). `winner = null`
  means a transaction the kernel never signed: a foreign signer or a rolled-back ledger. The kernel
  enters recovery and raises an alarm, and keeps the record, flagged foreign: that transaction may
  have created exposure the kernel cannot read, so the stop that follows is never clean ("a nonce identified as consumed by a transaction the kernel never signed halts and keeps its record, so no stop is clean").
- `confirmed` is the validator's check that a successful receipt shows the transition the reading
  promised (a `SetIsRootRatified(root, true)` log). §5 says how an unconfirmed success is read
  ("a success without its expected log never proves the commitment absent").

`NonceAt{latest}` beyond an unresolved record emits `findNonceTx`. If identification never arrives,
the record stays unresolved, its fee stays reserved, the clean predicate stays false, and the bound
turns the stop unsafe (trace: "a nonce consumed by a transaction the kernel cannot identify"). Its
candidates' `consumes` stay reserved by the nonce-record rule of §7.

**Loser semantics.** At a final resolution, every non-winning candidate is proven unable to execute.
"Dropped" is never a state here, because a locally abandoned transaction can still mine ("a replacement neutralizer that wins proves the original unable to run; a late receipt for it is ignored").

**The latch** is derived, not stored: some unresolved record has an `unknown` candidate, or is
foreign. While
latched, admission and dispatch run under the recovery policy only. The latch never clears on time.
When `head − unknownSince > latchBoundBlocks`, the kernel enters recovery ("a latch never clears on time or on a late rejection: past its bound the kernel recovers", "a foreign record reloaded at startup puts the kernel back in bounded recovery").

**Rebroadcast.** Every `stuckBlocks`, an unresolved record's `unknown` candidate is re-sent from its
stored `raw` if it is a recovery action (neutralizer or fill), or if it is a step whose plan is still
executing, **unexpired**, and the kernel is running. That last case is the one explicit
exception to "only the recovery policy while latched": re-sending the bytes that caused the latch adds
no new signature and no new exposure, and it is the fastest way to resolve the latch. Expiry, the
plan's end, or a stop revokes it, and the candidate is then left to resolve or be filled (trace: "an
expired plan is not rebroadcast while latched"). Re-sending needs no flush. Signing again would, and
KMS signatures are not deterministic, so a re-signed transaction would be a new candidate.

**Replacement.** A new candidate at an open nonce goes through the full pre-action check and commit
point with `feeLevel = max + 1`. The recovery controller (§10) occupies a record when the kernel is
recovering, or when all its candidates are `rejected` or `withheld`. It prefers the lowest open nonce not already
contested by recovery. A neutralizer goes there if some entry needs one, and otherwise a fill. A fill
competes with the original. Whichever wins resolves the nonce, and a winning original is reconciled
like any other (trace: "a replacement cancel that loses to the original").

**Fees.** The kernel prices every candidate by calling the **fee policy**, a function the bot hands
it at construction alongside its policy and validators: `feePolicy({kind, nonce, level, head,
admittedHead}) → fee`. Escalation schedules (a bump per replacement level, a fee target that rises
with a transaction's age) live there, not in the kernel. The kernel only clamps the result:

- a plan's own candidates get at most the tighter of the policy ceiling (`feeReserve`) and the plan's
  `maxSpendWei`, so a liquidation can't be bumped past what its expected profit allows
  ("a plan's fee ceiling bounds its own candidates below the policy ceiling", "the fee policy decides within the ceilings, and is clamped to the policy ceiling");
- recovery candidates (neutralizers and fills) get at most the policy ceiling, never the plan's, so a
  low plan ceiling can't stop that plan's exposure from being cancelled
  ("recovery neutralizers ignore the plan's ceiling, so a low ceiling can't stop a cancellation");
- if the fee policy throws or returns a non-positive fee, the plan step fails before it is exposed
  (the plan is abandoned, or compensates if an earlier step exposed something), and a recovery
  candidate is priced at the policy ceiling ("a fee policy that throws fails a step before exposure, but recovery still prices at the ceiling").

Reservations are unchanged: every unresolved nonce still reserves the full `feeReserve`, because
recovery may occupy any open nonce at the policy ceiling (trace file: `fees.test.ts`) (untested).

**`rejected` is not proof.** A definitive-looking RPC rejection is recorded, does not latch, and does
not resolve anything. The nonce is filled so that it resolves. `withheld` is handled the same way
("a rejected first broadcast is not proof the transaction cannot run: its nonce is filled", "a withheld recovery neutralizer hands its entry back, and recovery occupies the nonce again").

**Replacement traces.** Candidates at one nonce are mutually exclusive: they reserve the per-resource
maximum and one fee, not the sum, until the nonce is final ("mutually exclusive candidates reserve
the largest"). A winning replacement proves the original unable to run, and a late receipt for the
original is ignored once the record is pruned ("a replacement neutralizer that wins"). A losing
replacement leaves the original's effects applied ("a replacement cancel that loses").

## 7. Reservations

`holds(config, state)[r]` is the sum of:

- every unretired entry's `resources[r] − consumedFinal` (floored at zero)
  ("a fill observed at finality shrinks the reservation to what remains, and a full fill retires it"),
- for every nonce record, the per-resource **maximum** over its candidates' `consumes` (the
  candidates are mutually exclusive, so the maximum is what can happen), plus one `feeReserve` of
  `native` until the record resolves, and again if a reorg undoes the resolution
  ("mutually exclusive candidates reserve the largest, not the sum, until the nonce is final")
  ("the fee reserve of a nonce": "is held again when a reorg undoes the resolution, and admission respects it"),
- for every executing plan, its envelope `consumes` not yet committed, plus one `feeReserve` per
  uncommitted transaction step ("holds a later stage capacity while parked, and spends it on advance without re-checking")
  ("a plan whose only cost is its fee": "reserves its fee, and is not withheld after commit for stale evidence or a passed deadline").

`available(r) = min(caps[r], observed capacity[r]) − holds[r]`. A resource with neither a cap nor an
observation has zero capacity ("an admission that would exceed a cap is refused atomically", "capacity read at a block that is reorged away cannot back an admission").

- Release happens only by deletion (abandonment) or by final evidence: a final fill lowers an entry's
  remaining amount, a final retirement removes it, and a final resolution prunes a nonce record. The
  one exception is a nonce's fee reserve, freed at resolution so a run of included sends does not
  stall admission while finality lags. A reorg can over-commit fees by one reserve for every
  resolution it undoes, until it is observed, and admission stops while holds exceed the cap
  ("the fee reserve of a nonce": "is freed once its transaction resolves, so the next act is admitted before finality",
  "the fee reserve of a nonce": "can over-commit by one reserve across a reorg, and admits nothing until holds fall back").
- **Read-your-writes.** Every release other than abandonment can hide a balance change the kernel
  never observed: a fill it missed before a cancellation, the fee a mined transaction spent. So every
  such release raises `watermarks[r]` for the resources it released, at the evidence block. That is
  the entry's resources on retirement (neutralized, filled, expired, or never created), and `native`
  plus every candidate's `consumes` on a nonce prune. Any admission needing an observed resource
  then needs a `Capacity` reading at or after that block (`authorization.test.ts`). Abandonment raises nothing:
  nothing left the process, so no balance moved ("a final cancellation releases its reservation only against a balance read after it", "3c. a final transaction releases its fee reserve only against a native balance read after it").
- **Capacity is chain evidence.** A `Capacity` reading carries `(block, blockHash)`, is ignored unless
  canonical, and is deleted when a reorg removes its block (`reorg.test.ts`). For an observed resource,
  no reading means no capacity ("capacity read at a block that is reorged away cannot back an admission", "a capacity read that arrives late from an orphaned block is ignored").
- Double counting is deliberate and one-directional. Between inclusion and finality, a debit shows in
  the observed balance _and_ stays reserved. The kernel is briefly over-conservative, and never the
  reverse ("a provisional fill makes nothing available; a reorg of it is harmless; the final fill releases").

## 8. Chain evidence: canonicality, finality, reorgs

- The kernel keeps its own header chain from `Head` events. Evidence is **canonical** iff
  `headers[block] = blockHash`, and **final** iff canonical and `block ≤ finalized`. Kernel reads are
  pinned by block hash (EIP-1898 accepts `blockHash` for `eth_call`, `eth_getTransactionCount`, and
  `eth_getBalance`), so a numeric tag can never pick another fork ("a capacity read that arrives late from an orphaned block is ignored", "a restart resolves a transaction mined before it, once the block is vouched for"). The pinning is the chain adapter's to keep (review).
- The header source must supply the header at every height the kernel holds evidence for. That
  covers the window from the last finalized block to head at start, and any older height a receipt
  or `NonceTx` names. An older height arrives as `Header{number, hash}`, at or below the head, before
  the evidence that names it. Evidence at a height with no header is ignored until the header
  arrives, so missing headers make the kernel wait, never accept. After each `Head`, headers below
  both `finalized` and `head − max(maxSimLagBlocks, maxEvidenceAgeBlocks)` are dropped unless stored
  evidence still names them
  (a resolution awaiting its plan, a waiting commit's simulation, an entry's observation), so the
  kernel holds a bounded window. A dropped height can no longer reveal a changed finalized block,
  so the chain source must detect that itself and `Halt`; the chain adapter re-reads its last
  finalized block each poll ("a restart resolves a transaction mined before it, once the block is vouched for", "a header from beyond the head is ignored", "keeps only the headers above finality or the evidence age bound, so a long run holds a bounded window", "keeps the header a resolution names until the resolution is consumed").
- `finalized` is what `KernelChain.latest` reports; `createKernelChain` in `@repo/kit` reads it
  by the finality rule required by each `transactionKernelSpec`: the chain's `safe` tag, its
  `finalized` tag, or a fixed depth below the head. It never moves backwards: a `Head` reporting a
  lower finalized block is applied as a head but leaves `finalized` unchanged (untested).
- `Reorg{fork}` (or a `Head` whose hash conflicts at a known height) deletes headers above the fork.
  It clears every resolution, observation, and retirement evidence above it, and demotes a `live`
  whose liveness came from above it. **It never deletes a candidate, an entry, or a record.** An act
  taken in response to a rolled-back frame stays recorded until it resolves on the surviving chain
  ("a reorg never erases the record of an exposure made in response to a rolled-back frame").
- A reorg below `finalized` is a **finality violation**. The kernel enters recovery and raises an
  alarm. Final evidence already applied (retired entries, pruned records) is not re-opened
  automatically. That is operator territory, and a residual risk (§15; "a reorg below the
  finalized block is a finality violation and moves the kernel to recovery").
- Provider disagreement appears to the kernel as a reorg or as non-canonical evidence, which is
  ignored until canonical. Receipts and broadcasts use one designated provider each, as today
  (`createAccountSigner` sends raw transactions to the primary endpoint only) (review).

## 9. Protocol validators

### 9.1 Contract

```ts
type Validator = {
  id: string
  version: number
  accepts?: number[]                                         // older recorded versions it still recovers
  claims(payload): boolean                                   // dispatch; exactly one must claim
  read(payload, witness, { account, chainId }): ValidatorReading // total: refuse, never throw
  confirm(payload, logs): boolean                            // did a success show the promised transition?
}
type ValidatorReading =
  | { ok: false; reason }
  | { ok: true; creates: CommitmentSpec[]; exposes: Id[]; carries: string[]; retires: Id[]; consumes: Resources }
type CommitmentSpec = { id; exposure: 'broadcast' | 'inclusion'; resources; cap; expiry; neutralizer: TxPayload }
```

The kernel derives from a reading:

| Reading field | Kernel uses it for                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `creates`     | intended entries at admission, the envelope, resource reservations, the stored neutralizer, and the exposure mode |
| `exposes`     | which `signed` entries a carrier moves out of the process; must be this plan's                                    |
| `carries`     | the signatures a carrier reveals; each must be one this plan produced                                             |
| `retires`     | risk classification (reducing) and the `revoking` transition; each must be an owned entry                         |
| `consumes`    | reservations for effects that do not persist (a bridge send, a transfer)                                          |
| `confirm`     | whether a successful receipt counts as executed                                                                   |

The validators themselves, and what each one allows, are specified in
[`@repo/validators`'s SPEC](../validators/SPEC.md) (review).

Obligations on a validator. They are funds-at-risk code, reviewed like it, and fixed at construction:

- **Total and fail-closed.** Any shape it does not fully understand is a refusal. The kernel also
  contains a throw from every entry point: from `claims` or `read` it is a refusal, and from `confirm`
  it is "not confirmed", which §5 reads conservatively in both directions ("a validator that
  throws in claims or confirm is contained", "a validator that throws is a refusal, not a crash").
- **Plain data.** The kernel takes every step, payload and witness alike, in the form the ledger
  reads back (JSON with tagged bigints), and refuses one the codec cannot carry. A validator reads
  that form only, so a restart re-reads exactly what was admitted; class instances such as SDK
  trees arrive as their own fields and must be passed as plain data instead ("refuses a plan whose
  evidence the ledger cannot carry", "hands the validator evidence in the form a restart reads back").
- **Witness binding.** When the payload commits to a hash (a tree root), the validator must verify
  the step's `witness` against it. It must not trust a witness the payload does not bind. The witness
  is what the validator reads to derive exposure from the bytes; it is not the decision evidence a
  plan rests on (§4.4), and no fact can stand in for it (review).
- **Neutralizer proof.** `read(spec.neutralizer).retires` must include `spec.id`, with nothing
  created, exposed, or consumed. The kernel re-checks this at every start and before every use
  ("the recovery policy refuses a stored neutralizer whose reading also creates exposure", "a config
  whose recovery policy can no longer neutralize an owned entry refuses to start").
- **Versioning.** An entry records `validatorId@version`. A new release registers **one** validator
  per id, whose `accepts` lists the older versions it can still read and neutralize. Registering the
  old and new versions side by side would make both claim the same payloads, and dispatch refuses an
  ambiguous claim. Startup refuses a ledger holding a version no validator accepts. A validator that
  changes how it reads is a new version ("an upgrade that still accepts the recorded validator
  version starts and can neutralize", "an upgrade that drops the validator version an entry was
  recorded under refuses to start").
- **Observation.** `Validator` has no hook for observation. The bot supplies the commitment read as
  `KernelChain.commitment(id, at)` (Midnight: `consumed(maker, group)`, built with
  `midnightCommitmentRead` from `@repo/validators`), interpreted into `{consumed, neutralized}`, and
  the kernel receives it as `CommitmentObserved` (review).
- **Units.** Resource keys are opaque strings with the validator's own units (`loan:<token>` in
  token base units). Caps in config use the same keys (review).

### 9.2 Midnight offers

Facts, from the Midnight contracts source and `@morpho-org/midnight-sdk` 1.3.0:

- `setConsumed(bytes32 group, uint128 amount, address onBehalf)` requires
  `amount ≥ consumed[onBehalf][group]` and, with `type(uint128).max`, "cancels all offers in the group
  (and never reverts)". `consumed` is monotonic (review).
- `take` checks each offer's own `maxAssets` (or `maxUnits`) against the group's shared `consumed`,
  and `block.timestamp ≤ offer.expiry`. It also requires `isRatified` from the offer's ratifier
  (review).
- `SetterRatifier.setIsRootRatified(maker, root, bool)` ratifies or unratifies a whole tree.
  `EcrecoverRatifier` checks an EIP-712 `OfferTree` signature over the root, which is replayable by
  design, and offers `cancelRoot(maker, root)` (review).
- Publication sends `Payload.encode(items)` to the `midnightMempool` address as raw calldata. Items
  carry each offer and its `ratifierData`, including the Ecrecover signature (review).
- `Tree.mempoolValidate({ ratification: { type: 'ecrecover', signature } })` posts the ratified
  payload, **signature included**, to the Morpho API. The quoter validates the unsigned tree before
  ratification and a Setter tree again after its ratification lands; it posts no Ecrecover
  signature (`production-ladder.ts`) (review).

The validator. A transaction payload is `{to, data, value}`, exactly what is signed: a validator
decodes `data`, and nothing between it and the signer re-encodes anything. The reference model,
[`test/validators.ts`](./test/validators.ts), decodes a stand-in encoding (`test/codec.ts`: canonical
JSON of the real function and argument names) where the production validator
(`midnightOffersValidator` in `@repo/validators`) decodes the SDK payload codec and ABIs (review).

| Payload                                                     | Witness | Reading                                                                                                                                                         |
| ----------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typed `OfferTree{root}` at `ecrecoverRatifier`              | tree    | root check; offers must have the kernel's maker, the Ecrecover ratifier, allowlisted markets, and positive caps; `creates` one `broadcast` commitment per group |
| `publish(items)` to the mempool                             | tree    | root check; with signatures, `exposes` the tree's groups and `carries` the signatures; without (Setter), nothing                                                |
| release to `midnight-api` (`mempoolValidate`)               | tree    | the same as a signed publish                                                                                                                                    |
| `setIsRootRatified(maker = account, root, true)`            | tree    | root check; offers must have the Setter ratifier; `creates` one `inclusion` commitment per group                                                                |
| `setConsumed(group, type(uint128).max, account)`            | —       | `retires [midnight:group]`                                                                                                                                      |
| anything else, including partial `setConsumed` and unratify | —       | refused                                                                                                                                                         |

Per group: `cap = max(maxAssets)` over its offers, because the bucket is shared and the largest cap
bounds what can be taken. `expiry = max(expiry)`. Resources are `loan:<loanToken> = max buy maxAssets`
and `debt:<market> = max sell maxAssets`. The neutralizer is `setConsumed(group, uint128.max,
account)` on Midnight. It is root-independent, so it neutralizes the group however many trees carry
it, and it never needs market configuration. `confirm` checks the `SetIsRootRatified` or
`SetConsumed` log ("the reservation is the validator reading of the payload: the largest cap in the
group", "a success without its expected log never proves the commitment absent").

Out of the reference model, and required in production: `maxUnits` caps, `start`, `reduceOnly`,
`continuousFeeCap`, callbacks (the reading must refuse any non-zero callback it cannot bound), maturity
versus expiry, and batch neutralization (`multicall` of `setConsumed`, `cancelRoot`, unratify). A batch
is valid only if its reading retires exactly the ids it claims (review).

The production validator (`@repo/validators`) gives a group one shared cap, in units or in assets,
and reserves a buy's `loan:<token>` at that cap either way: every tick prices a unit below one
asset, so a unit cap bounds the assets any fill can pay (review).

### 9.3 No persistent commitments

For a liquidator on the generic Executor, it claims only `to = executor` and reads `exec` with zero
value as nothing. Typed data and every other target stay unclaimed and are therefore refused.
Inner-call integrity stays with the signer policy (the `exec_606BaXt` selector pin and the outer
envelope; the liquidators configure no `MulticallPolicy`) and simulation, as today. The kernel ADR
asks for more from a production validator: "no commitment" must be shown from
the payload, by checking that the nested calls sweep every asset they touch (ADR-2026-05-28). The
reference model's validator does not decode nested calls; the production one,
`executorLiquidationValidator` in `@repo/validators`, does. It decodes `exec_606BaXt`, the protocol's
`liquidate` and the callback queue it runs, and requires that the callback transfers nothing out,
that the trailing calls sweep the market's tokens and every token the callback approves to the
account, and that every call it decodes re-encodes byte for byte. Anything it cannot decode exactly is refused;
venue calls inside the callback stay opaque, bounded by simulation. The kernel gives this bot nonce
records, the latch, fills, and the clean-stop predicate.
That is exactly what a liquidator with an unknown-outcome transaction needs (trace: "a clean stop
waits for an unknown-outcome liquidation").

## 10. Recovery controller and lifecycle

**Lifecycle.** `idle → starting → running → recovering → stopped(clean | unsafe)`. `stopped(refused)`
means `Start` failed its checks and touched nothing ("recovery that hits its bound stops unsafe,
keeps everything durable, and gates the next start", "a missing ledger for an enrolled account
refuses to start rather than assuming no history").

- **`starting`** admits only risk-reducing work. It becomes `running` when all three hold: a
  `NonceAt` has been read, every record below the chain's nonce is resolved, and every unretired entry
  has been observed at or after the first head since start. A loaded foreign record sends it to
  `recovering` (`foreign nonce outstanding at start`) as soon as a `NonceAt` and a head are read,
  without waiting for its lookup or any observation.
  Waiting on a startup read never suspends the dead-man switch: once any open entry's affirmation
  lapses, `starting` goes to `recovering` with reason `affirmation lapsed during startup` ("a restart
  holding a foreign record recovers without waiting for its lookup", "a restart that never sees its
  offer observed still withdraws it once affirmation lapses").
- **`running`** is the normal state (review).
- **`recovering(reason)`** is entered on `Stop`, `Halt`, latch bound, flush failure, stuck
  compensation, finality violation, an external or unrecorded nonce, or a chain nonce ahead of the
  ledger while running. Pre-commit plans that are not risk-reducing fail at once. Recovering is
  terminal-bound: it only ends in `stopped`. A second halt is ignored, because recovery runs once
  ("a halt from anywhere in the bot is a stop: one recovery, the same terminal predicate", "stop
  abandons unexposed work at once and never reports clean while an entry is open").

**Adoption at start.** `Start` observes every loaded entry before `running` and keeps only what the
current configuration would still create. It skips an entry already flagged `compensate`, and
re-reads every other entry's stored origin under the normal policy, in ledger order. It keeps the
entry only if the reading still creates it within its recorded bounds and its remaining resources
(after final fills), added to those already kept and to what open nonce records hold, fit `caps`. A
`revoking` entry is checked too, because a losing cancellation hands it back with the flag intact. A
resource with no cap that the kernel observes is not checked here, since no observation exists yet;
the first admission still needs one. An entry that fails is flagged `compensate` with a
`compensating` notice naming the reason, and the recovery controller withdraws it. What is kept
still answers to the dead-man switch across restarts (`restart.test.ts`: "keeps a live commitment
the current policy still allows", "trims, in order, the commitments that together exceed a lowered
cap", "counts what pending transactions hold against the cap", "withdraws a revoking commitment the
current policy refuses once its cancellation loses", "withdraws a commitment the bot stops
re-affirming, however often it restarts").

**The recovery controller** runs on every pass while running or recovering:

- It starts a neutralizer plan for every `exposed` or `live` entry that is not stuck and needs one: the
  kernel is recovering, the entry is flagged `compensate`, or `now − affirmedAt > revokeAfterStaleMs`.
  The last case is a dead-man switch: the engine re-`Affirm`s entries it still wants, and one it stops
  affirming (because its decision graph is wedged, its inputs are stale, or it no longer desires the
  entry) is withdrawn by the kernel, without the graph ("an entry the decision graph stops affirming
  is withdrawn by the kernel on its own").
- It starts a fill for every occupiable record that is all `rejected` or `withheld`, or that is
  stuck while recovering ("a rejected first broadcast is not proof the transaction cannot run: its
  nonce is filled", "a fact that changes during the flush withholds a risk-increasing broadcast; the
  recorded nonce is filled"). When a recovery fill fails before exposure, that nonce waits until a
  strictly higher head before another fill starts; ticks and duplicate or lower heads do not retry,
  and one nonce's wait does not delay another nonce or a neutralizer ("a recovery fill whose %s fails
  waits for a later head", "a failed recovery fill does not delay a fill for another nonce", "a
  failed recovery fill does not delay a neutralizer"). The failure-head mark is process-local ("a
  failed recovery fill pace mark is process-local").
- Each neutralizer re-authorizes the entry's stored neutralizer with the current validator and
  recovery policy, and requires `retires ∋ id`. After `maxRecoveryAttempts` plans, or if authorization
  fails, the entry is **stuck** and the kernel enters recovery with reason `compensation_failed`
  ("compensation that cannot complete keeps the exposure and ends in recovery and an unsafe stop",
  "an entry whose neutralizer is reorged into a revert after its last allowed attempt is stuck, not
  retried").

**Terminal predicates** ("a clean stop waits for an unknown-outcome liquidation to resolve at
finality", "clean is reported only after the final flush is acknowledged", "a failed final flush is
an unsafe stop", "an unrecorded pending transaction is an open obligation, never a clean stop").

| Predicate          | Definition                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan abandoned     | failed with nothing exposed; its reservation is gone in the same transition                                                                                                                                                 |
| intent may repeat  | its plan is terminal and no unretired entry or open record names it                                                                                                                                                         |
| nonce resolved     | a canonical resolution at a final block; losers are then proven unable to execute                                                                                                                                           |
| commitment retired | final positive evidence (§5 table)                                                                                                                                                                                          |
| **clean stop**     | recovering; no unretired entry; no nonce record (foreign ones included); no plan past its commit point; no slot held; and `ackedSeq ≥ seq`, so the final flush is acknowledged. Until then the kernel waits in `recovering` |
| **unsafe stop**    | recovering for `recoveryBoundMs`, a fenced flush, or any failed flush while recovering (including the final one); `report.open` lists every open entry and nonce                                                            |
| next start gated   | any durable entry or record: `starting` until resolved or observed, latched while unknown                                                                                                                                   |

## 11. Durable format and crash boundaries

### 11.1 Format

One file per `(chainId, account)` (`DurableLedger` in `types.ts`), written as canonical JSON with
tagged bigints (`durable.ts`). A stored key that starts with `$` is written with one more `$`, so
a key with a single `$` is always a codec tag and any id reads back as itself; an unknown tag fails
the read. `createLedgerStore` (`store.ts`) writes it to a fresh `0600` file,
fsyncs it, renames it over the old one, and fsyncs the directory, one write at a time in `seq`
order, each encoded when it is requested. It creates only the last directory and syncs its parent once per process,
so the volume above it must already be durable; a volatile overlay mount voids every guarantee
here. Anything at the path that is not a parseable regular file (empty, `null`, a dangling symlink,
a directory) reads as present and malformed, never as absent, so neither an enrolled nor an
enrolling start can pass it. Temporaries a crash left are deleted at startup:

```
header      { format: 4, chainId, account, seq }
nextNonce   the next nonce the kernel would allocate
entries     exposed | live | revoking entries: spec (incl. neutralizer), state, intentId,
            validator id@version, creators, deadCreators, origin (the creating payload and its
            witness), consumedFinal, prior, neutralizing, compensate, affirmedBy (last
            affirmation, floored to revokeAfterStaleMs / 4)
nonces      open records: every candidate with hash, raw bytes, payload, kind, intentId, step,
            creates/exposes/retires/consumes, feeLevel, fee, sent, writes (its plan's conflict
            writes), authority (the evidence and decision record it was sent on); the record's
            unknownSince and foreign flag
submissions submission id → { intentId, status, digest }
watermarks  resource → block of the last final effect on it
conflictMarks [conflict id, block] pairs: our own last inclusion or release writing each id,
            above the evidence floor
evidenceFloor at least every conflict mark pruned, written with the prune
releases    intent id → { writes, after, restored? }: the conflict ids its release writes, one past
            the highest head seen while it may still leave, and whether a restart restored it,
            until they are marked
```

What survives a restart is exactly what a crash loop must not reset. The dead-man switch
(`affirmedBy`), pending compensation, the latch's age (`unknownSince`), and the read-your-writes floors
all persist, so repeated restarts can neither keep an unaffirmed offer alive nor dodge the latch bound
(traces: "a restart does not extend an unaffirmed offer past its stale bound", "a restart does not
restart the latch bound"). `stuck` and
`recoveryAttempts` reset on purpose: a new process, often with fixed config, gets a fresh bounded
attempt, and each attempt is a neutralizer, which costs gas and never safety.

Signed raw transactions are on disk. They are not secrets once broadcast, but they are exposure
material before that, so the file is `0600` and never logged (review). The format has no field for a key, a
credential, or a URL, and typed-data signatures appear only inside a candidate's raw bytes. Witnesses,
decision records, and payloads are stored as given, so a validator or caller must not put a key, a
credential, or a credentialed URL in them ("round-trips a ledger the kernel then adopts, in an
owner-only file and directory").

### 11.2 What is flushed before each irreversible act

| Irreversible act                               | Flushed before it (one atomic write)                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| first broadcast at a nonce                     | the candidate (hash, raw, reading), `nextNonce`, created entries `exposed`, carried entries `exposed`, submission `exposed` |
| replacement broadcast (fee, neutralizer, fill) | the new candidate; retired entries `revoking` with `neutralizing` and `prior`                                               |
| release of a signature to an offchain party    | carried entries `exposed`, submission `exposed`, the release's conflict writes                                              |
| rebroadcast of recorded bytes                  | nothing new: the bytes are already durable                                                                                  |

All other durable changes are flushed lazily in the same pass, but nothing waits on them: `live`,
retirement, pruning, submission terminal status. **Losing a lazy write can only make the next start
more conservative.** A lost retirement is re-learned from the chain (trace: "after retirement but
before the lazy flush"); a lost resolution is re-resolved, and a lost terminal status reads as
`interrupted`.

### 11.3 Crash boundaries

| Crash between                            | Disk holds                        | Recovery rule                                                                                                                         | Trace                                                   |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| admission and any signature              | nothing new                       | the plan is gone; the reservation is gone; the nonce is reused                                                                        | before any signature                                    |
| typed signature and its carrier's commit | nothing new                       | the signature died in memory                                                                                                          | after a typed signature                                 |
| commit point and the flush landing       | old file                          | nothing left the process; the same nonce is reused                                                                                    | after the commit point but before the flush             |
| flush landing and the broadcast          | candidate, `exposed` entries      | the candidate is `unknown`, so the kernel is latched; the entries are observed; the bound → recovery → neutralizer occupies the nonce | after the flush is written but before the broadcast     |
| broadcast and its result                 | same                              | the receipt resolves it; entries `live`; adopted                                                                                      | after the broadcast but before its result               |
| neutralizer flush and its broadcast      | candidate, `revoking` entry       | the stored bytes are re-sent, not re-signed                                                                                           | after a neutralizer is flushed but before it is sent    |
| release flush and its answer             | its conflict writes in `releases` | the release may have left: they are marked at the first head `h` after the restart at `max(after, h + 1) + K + 1`                     | a release that crashes between its flush and its answer |
| final retirement and its lazy flush      | a stale `live` entry              | re-observed and retired again                                                                                                         | after retirement but before the lazy flush              |
| unsafe stop and the next start           | everything open                   | `starting`; latched while a restored record is `unknown` or foreign; unretired entries observed before `running`                      | recovery that hits its bound                            |

### 11.4 Startup checks (all fail closed as `stopped(refused)`)

The `Start` event carries the parsed file as `unknown`. `validateLedger` checks the whole schema and
the invariants across records before any of it becomes state. Anything else is `malformed ledger`,
never a partial load. That covers: the header binding and format; every entry in a persisted state
(`exposed`, `live`, `revoking`) with bigint amounts, a well-formed neutralizer, and its origin; a
`revoking` entry exactly when it names a neutralizing candidate, and that candidate recorded at that
nonce; every nonce record stored under its own nonce and below `nextNonce`; unique, well-formed
candidates and their conflict writes; well-formed submissions, watermarks, and owed releases. A
partial load would read as _less_ exposure, which is the one direction a ledger must never fail in
("refuses a ledger whose conflict marks are missing or malformed", "refuses a ledger whose owed
conflict writes are missing or malformed", "refuses a ledger whose candidate carries a malformed
authority").

- The account is enrolled and no ledger exists (lost volume): refused. Enrollment lives in deployment
  config, not on this disk ("a missing ledger for an enrolled account refuses to start rather than
  assuming no history").
- The ledger exists but the start is an enrollment: refused ("an enrollment against an account that
  already has a ledger refuses").
- The ledger header names another `chainId` or `account`, or any record fails validation: refused
  ("a ledger bound to another …", "a stored payload whose calldata is not hex makes the ledger
  malformed").
- `format` is not `LEDGER_FORMAT`: refused as unknown. Any change to the record shape bumps the
  format (`test/format.test.ts` records each shipped shape and type-checks the live `DurableLedger`
  against the one `LEDGER_FORMAT` selects); migration is an explicit offline step that writes the
  new format ("a ledger in format …").
- A stored entry's validator version is not registered, or its neutralizer fails re-authorization
  under the current recovery policy: refused ("an upgrade that drops the validator version an entry
  was recorded under refuses to start", "a config whose recovery policy can no longer neutralize an
  owned entry refuses to start").
- The chain nonce (latest or pending) is ahead of `nextNonce`: refused. A transaction this ledger
  never recorded is a rollback or a foreign signer. This also catches a rollback that spans a
  broadcast ("a rolled-back ledger is caught when the chain nonce is ahead of it", "a rolled-back
  ledger is caught when only the pending nonce is ahead of it").
- A fresh enrollment with `pending ≠ latest`: refused ("a fresh enrollment over an unrecorded pending
  transaction refuses to start").

### 11.5 Rollback, fencing, and single ownership

- **Rollback.** Only the nonce check above guards against a restored older ledger, and it cannot see
  a rollback of signature-only exposure (§15). A remote watermark would close that; the kernel ADR's
  supplement describes one, and no deployment needs it yet (review).
- **Fencing.** An exclusive `flock` on the ledger directory, plus an `epoch` incremented at each start.
  A flush that finds a newer epoch is `FlushFailed{fenced}`:
  the kernel stops unsafe at once and sends nothing more. `createLedgerStore` takes neither the lock
  nor an epoch yet: until it does, single ownership is operational (one replica per ledger volume)
  ("a fenced flush stops at once without broadcasting").
- **Transactions across ledger and nonce records.** They are one file and one write, so there is no
  cross-file ordering to get wrong (review).
- **Write ordering.** The runtime has one writer per ledger and applies flushes in `seq` order. A
  `Flushed{seq}` acknowledges every write up to `seq`. A `FlushFailed{seq}` affects only plans whose
  commit flush is at or below `seq`; a stale failure for an older write cannot mark a newer candidate
  (untested)
  ("the acknowledgement of an earlier flush does not release a later exposure", "applies writes in
  call order and keeps going after one fails").
- **Lost ledger.** Enumerating groups from the book or API history is **not** sufficient: nothing
  guarantees that every escaped signature was ever indexed. Re-enrollment requires one of three
  demonstrable conditions. The first is complete invalidation at the protocol level, which Midnight
  does not currently offer for Ecrecover signatures beyond per-root and per-group calls. The second
  is that every commitment the account could have signed is past an enforceable expiry bound. That
  requires a deployment-wide maximum offer expiry, enforced by the validator, and waiting it out.
  The third is revoking the authority itself: a new maker account, or revoking the ratifier or signer
  authorization (`setIsAuthorized`), so old signatures stop being valid. Until one holds, the account
  stays unenrolled and the bot runs on a fresh account (review).

## 12. Obligations and where they hold

| Obligation                                                                 | Where                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution authorization and late correlation                               | §1 (requests vs hashes), §4.4 (the tuple), §4.5 (commit point); traces in `authorization.test.ts`                                                                                                                                                                                                                 |
| complete transition tables                                                 | §4.3 (plan), §5 (entry), §6 (candidate and record), §7 (reservation as a derived function), §10 (lifecycle)                                                                                                                                                                                                       |
| signature-only steps, reverts, partial fills, partial compensation         | §4.3 `sign`, §5 inclusion vs broadcast, §7 final fills, §4.3 fail; traces: offchain release, ratification reverts, final fill, later step failing                                                                                                                                                                 |
| validator contract incl. versions                                          | §9.1                                                                                                                                                                                                                                                                                                              |
| staged vs whole-plan reservation                                           | whole-plan **envelope** verified from readings; dependent steps must fit (§4.1–4.2). Ordinary pending transactions are reserved through nonce records (§7)                                                                                                                                                        |
| fee capacity, exclusive candidates, debited balances                       | §7                                                                                                                                                                                                                                                                                                                |
| nonce recovery with no commitment                                          | §6 fills and `findNonceTx`; §9.3                                                                                                                                                                                                                                                                                  |
| durability, fencing, migrations                                            | §11                                                                                                                                                                                                                                                                                                               |
| policy changes during recovery                                             | a stored neutralizer is **re-authorized, never replayed blindly**: the current validator must read it as retiring the entry, under the current recovery policy. A config that cannot do so refuses to start (trace) rather than failing mid-recovery. Market config is not an input to neutralizer authorization. |
| block-hash pinning, canonicality, provider disagreement, finality reversal | §8                                                                                                                                                                                                                                                                                                                |
| terminal predicates                                                        | §10                                                                                                                                                                                                                                                                                                               |
| kernel chain reads independent of the bot's sources                        | §3                                                                                                                                                                                                                                                                                                                |
| plain events-in/state-out API                                              | §13                                                                                                                                                                                                                                                                                                               |
| durable submission handoff (kernel side, single chain)                     | §1 submission identity, §11 submissions, §13.2. The cross-chain contract itself is not specified                                                                                                                                                                                                                  |
| metadata refresh renewing authorization                                    | the bot's sources: a read's expiry bounds `notAfter` (§4.4). The kernel's protections do not depend on it: `notAfter` is decision validity only, and every transaction is re-simulated and every exposure re-authorized regardless                                                                                |

## 13. Interfaces

### 13.1 Hosted on the engine

`createKernel(config)` returns `{ initialState, reduce, withholds, signRefusal }`, the last two being
the executor's guard questions. Bots never call it: `declareKernel` in
[`host.ts`](./src/host.ts) declares it in a bot's graph, and tests run it on a runner of its own
with `startKernel` from `@repo/kernel/testing`. The bot pushes `Submit`, `Advance`, `Affirm`, `Stop`
and `Halt` to `nodes.requests`, or emits them from its library folds into the nodes it passes as
`requests`, and
reads `nodes.state`, `nodes.activity`, `nodes.heads` and `nodes.commands`, the commands each
transition issues, which the controller reads to check that an act's facts reach the kernel.
`kernel.start(runner)` requires `runner.hasJournal`; otherwise it rejects with
`KernelJournalRequiredError` before pushing `Start` ("refuses to start without a journal before
pushing Start").
A bot process owns its stop lifecycle. On `SIGINT` or `SIGTERM` it pushes `Stop` and emits
`shutdown` with `signal`. When the runner settles it emits `kernel.stopped` with `outcome`, `reason`
and `open`, or `runner.failed` with `error`, `origin` and the report fields `outcome`, `reason` and
`open`, then chooses its process exit code (review).
`nodes.activity` is history: what the
kernel observed and did in each transition. No event retracts an inclusion a later reorg undoes, so
current inclusion, exposure and plan status are read from `nodes.state`, never accumulated from
activity. The host declares:

- `observe`, a fold that carries each request to the kernel with the current observation of every
  fact it names, and every later change to a fact a plan still rests on, its expiry included, from
  the keyed nodes the bot passes as `facts`. An absence a complete read implies carries that read's
  expiry, for a key the node never enumerated too ("seeds a submission with the expiry of an absence
  only a complete read implies", "tells a subscribed key it never carried when its implied absence
  moves, gains or loses an expiry", "carries each plan its facts, and signs nothing once one changes
  before the signer signs");
- `kernel.merge`, a fold over the start, chain, effect-result, observation and tick nodes in delivery
  order, which writes a `Tick` stamped at the result's push before each effect result, so a late
  result is judged when it arrives; and `kernel.state`, the reducer as one fold ("judges a late effect
  result at the time its push arrives", "judges a late flush acknowledgement against the time it
  arrives");
- the executor ([`executor.ts`](./src/executor.ts)), an effect over the kernel's commands: it
  materializes, simulates at the kernel's own head (deferring while there is none), signs, flushes
  through `createLedgerStore` in `seq` order, and sends. A signer and a send each get a guard whose
  `mayAct()` asks the kernel immediately before the key signs and before the network act;
  each guard's verdict is journaled when the runner has a journal. A send that throws or times out after its guard permitted the handoff is read as `unknown`; before it, as `withheld`. Every effect but the flush
  is bounded by `effectTimeoutMs`, and a send is aborted once `maxDispatchLagMs` has passed since it
  was dispatched; a flush waits for the store to settle, since a flush that timed out could still
  land ("holds a simulation requested with no tip until a fresh head, instead of failing it", "asks the
  kernel before the signer signs, and signs nothing once a fact changed", "journals each handoff
  guard verdict with the time it observed", "reports unknown, never withheld, once the guard has let
  a send go", "withholds a send that timed out before its guard ever let it go", "aborts a send still
  waiting past the dispatch window");
- the chain adapter ([`chain-adapter.ts`](./src/chain-adapter.ts)), an effect on the poll clock
  over the bot's `KernelChain` reads. The host reads the ledger and the account's code, then lets
  `Start` through before the first poll, which delivers the window from finality (or `reorgDepth`
  below the head) to the head, and guarantees:
  - every chain read after `Start`, nonce lookups included, runs in the one serialized poll, so no read observes
    state another invalidated mid-flight; a reset or rollback also bumps a generation that every
    read checks before it delivers ("finishes a slow vouch inside its poll, so it never checks an
    anchor that moved on", "reads nothing at a tip fetched before the finalized chain was found
    replaced", "drops a nonce lookup whose vouch finds the finalized chain replaced");
  - every block delivered as a `Head`, each fetched parent checked against the link it continues,
    so a source that changes forks mid-walk delivers nothing; a fork within `reorgDepth` delivered
    as `Reorg` before any replacement read; a head behind the tip, once the tip is gone from the
    source, as `Reorg` to that head; a fork deeper than the window, like a changed finalized block,
    as `Halt` plus `Reorg{fork: -1}`, which drops all evidence, since no height is proved to
    survive; the finalized anchor taken only from the branch just delivered ("never delivers blocks
    that do not link, when the source changes forks mid-walk", "rolls back to a head behind its tip,
    so nothing is pinned to the block it lost", "halts rather than follow a head that forks below
    the finalized anchor", "rolls back to finality on a reorg deeper than it retains, so orphaned
    evidence is not final", "takes a newly finalized anchor from the branch it just delivered, not
    the one it replaced");
  - a `Header` from its own reads immediately before any receipt or `NonceTx`, re-checking the
    finalized anchor first when that height is final ("a restart resolves a transaction mined before
    it, once the block is vouched for", "does not vouch for a final block once the finalized chain
    changed under it");
  - the last finalized block re-read each poll, a change to it handled as above, and newer
    finality delivered even when the head has not moved ("carries finality forward on an unchanged
    head, so a resolved record settles", "forgets a final-looking receipt when the finalized chain is
    replaced, so it cannot settle");
  - each evidence read isolated, so one failing read never starves the others ("keeps reading
    observations when a nonce lookup keeps failing"), with nonce lookups last and at most a few per
    poll (untested).

`@repo/kit`'s `createKernelChain` and `createKernelEffects` supply the chain reads and the
effects over viem and the account signer, leaving the protocol's commitment reads and
dependent-step builders to the bot. Effects must not act once their `AbortSignal` aborts, since a stalled event loop can fire
the abort late (review).

**The kernel is its graph's recovery.** When any other operator or effect in the bot's graph fails,
the runner stops the rest, and the kernel halts and runs on alone until it stops, withdrawing what it
holds; the runner's `stopped` then rejects with a `GraphFailedError` carrying the kernel's report. A
failure inside the kernel stops the runner at once. When the journal fails or overflows, the kernel
halts into recovery; no send waits on the journal. `runner.abandon()` aborts every effect still
waiting and resolves once writes already handed to the store have settled, so a restart never races
an older write. The crash-injection suite (`host.anvil.test.ts`) uses it to restart the kernel on a
local chain at the four ordinary-transaction boundaries of §11.3: before any signature, before the
flush lands, before the broadcast, and before its result ("halts and stops cleanly when a bot
operator fails in the step that starts it", "halts a kernel composed into a bot graph into recovery
when the journal fails", "halts into recovery when the journal overflows, refusing new acts while it
withdraws", "aborts an effect still waiting to act when abandoned", "resolves abandon only once a
write already handed to the store has settled").

The kernel path signs with the signer's `sign` and hands off with its `broadcastRaw`, so the flush
sits between them (review).

**Configuration.** `KernelConfig` ([`types.ts`](./src/types.ts)) and `KernelHostOptions`
([`host.ts`](./src/host.ts)) are fixed at construction. `maxEvidenceAgeBlocks` is range-checked by the
kernel and `pollMs` must be positive, as every clock's period is (untested); every other value is trusted as
given ("refuses a configured bound that is not an integer in its range").

| Option                                     | What it bounds                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `chainId`, `account`                       | The kernel's identity (§1); a ledger for another identity refuses to start (§11.4)                              |
| `validators`                               | What an action means (§9)                                                                                       |
| `policy.targets`, `policy.recoveryTargets` | Default-deny transaction targets in normal and in recovery mode (§4.2)                                          |
| `caps`                                     | What reservations and kept commitments may hold, per resource (§7); a restart trims what exceeds them (§11.4)   |
| `observedResources`                        | Resources the chain adapter reads each poll; one is refused for capacity until read after our last effect on it |
| `feeReserve`                               | The native ceiling reserved per unresolved nonce (§6, §7)                                                       |
| `feePolicy`                                | Each candidate's fee ceiling, which the kernel clamps (§6)                                                      |
| `maxSimLagBlocks`                          | How far below head a simulation may be (§4.4)                                                                   |
| `maxEvidenceAgeBlocks`                     | The evidence floor (§4.4); refused at construction unless an integer in [0, 2³²]                                |
| `latchBoundBlocks`                         | How long the latch may hold before the kernel enters recovery (§6)                                              |
| `stuckBlocks`                              | How often an unknown candidate is rebroadcast (§6)                                                              |
| `revokeAfterStaleMs`                       | How long a commitment stands without `Affirm` (§10); the ledger stores affirmations to a quarter of it (§11.1)  |
| `maxRecoveryAttempts`, `recoveryBoundMs`   | Recovery's attempt and time limits, past which the entry is stuck or the stop unsafe (§10)                      |
| `maxDispatchLagMs`                         | How long after its final check an act may still be dispatched (§4.5)                                            |
| `enrollment`                               | Whether a ledger must already exist (§11.4)                                                                     |
| `pollMs`                                   | The chain adapter's poll interval                                                                               |
| `effectTimeoutMs`                          | Every effect's time limit but the flush's; a send's is the smaller of it and `maxDispatchLagMs`                 |
| `finality`                                 | The required finality tag or fixed depth that `createKernelChain` reports (§8)                                  |
| `reorgDepth`                               | How many delivered blocks are kept to find a fork; a deeper reorg halts the kernel (§8)                         |

### 13.2 Durable submission handoff: kernel side only, single chain

**This section is not cross-chain support.** It specifies only what one single-chain kernel offers a
future coordinator: an idempotent submission contract (review).

It is a durable handoff, not delivery. Within one process an active submission id is not executed
twice, and once its first exposure is durable a resubmission returns `known`; a crash before that
loses the in-memory reservation, and the query then answers `unknown`. A
request or answer lost between the coordinator and the kernel is recovered only by querying and
resubmitting, so nothing here is exactly-once over a network. No retention protocol exists either:
a record is kept for the life of the ledger. Gates across chains, transit commitments,
cross-kernel recovery authority, hedge legs, resting states, and the coordinator's own durability are
unspecified, and nothing here should be read as having solved them ("a submission identity is
answered idempotently across a crash instead of re-executed", "a crash before any exposure leaves no
submission record, so resubmission is safe").

- **Submit** a step's plan with `submissionId = saga/step`. The kernel binds the id to the plan's step
  digest and reserves it in memory at admission. It becomes durable at the plan's first commit
  point, in the same write as the exposure, or lazily at settlement for a plan that exposes nothing.
  A concurrent or later submission with a different digest is refused (`lifecycle.test.ts`: "a second
  submission with the same id before any commit is answered, not executed", "after a restart a
  conflicting resubmission of an exposed submission is refused", "a submission id is bound to its fee
  ceiling as well as its steps").
- **Query** with `querySubmission(state, id)`, which returns:
  - `unknown`: nothing was exposed; resubmitting is safe ("a crash before any exposure leaves no
    submission record, so resubmission is safe").
  - `in-progress` ("a submission identity is answered idempotently across a crash instead of
    re-executed")
  - `interrupted`: exposed, then the process restarted; its exposure is in the ledger ("a crash after
    the first exposure keeps the submission record, so resubmission is refused").
  - `settled`, `compensated`, or `failed` (untested).
- **Resubmit** of a known id returns `known` with that status and executes nothing. This closes
  the duplication window (the kernel broadcast, then crashed before the coordinator recorded
  acceptance), because the kernel's record is written _before_ the broadcast. It also closes the
  opposite window (the coordinator recorded the step before the kernel accepted it), because the query
  answers `unknown` ("a submission identity is answered idempotently across a crash instead of
  re-executed", "a crash after the first exposure keeps the submission record, so resubmission is
  refused").
- **Acknowledge** is not modeled. It would let the kernel drop the record once the coordinator has
  durably recorded the result; until it exists, records accumulate (review).

Gates, transit commitments, cross-kernel recovery authority, hedge legs, and resting states are
coordinator and bridge-validator concerns, deferred to the first cross-chain bot. One constraint on them from this spec: a kernel's recovery mode admits no action that creates,
exposes or consumes, and retires only entries _it owns_, so a transit commitment that must be
completed on another chain needs a cross-kernel authorization contract that does not exist yet ("a
step calling itself compensation for a commitment the kernel does not own is refused", "is still new
work: refused while the kernel is latched or recovering").

## 14. What is deliberately left out

- **Fee-bump arithmetic and replacement of a still-valid step.** Escalation is the fee policy's job
  (§6, "Fees"); `bumpFees` is one candidate implementation. The spec requires only that a bump pass
  through the commit point as a new candidate and stay within the clamps.
- **Batch neutralization.** It is an optimization with a clear rule (§9.2).
- **Offchain book reconciliation and orphan adoption** (groups the API shows but the ledger lacks).
  The kernel does not adopt orphans. A decision-layer reservation does not bound kernel admission
  either, so it is not enough. The rule this leaves: an account migrates onto a kernel only with a
  **verified import** or **drained**. A verified import is every exposed commitment, imported as a
  ledger entry whose neutralizer the current validator accepts, checked against chain state before
  the first `Start`. Drained means no unexpired commitment exists, established as in §11.5, "Lost
  ledger". The import tool is a separate, reviewed step.
- **Refusal memoization.** The kernel refuses cheaply and keeps no memo.
- **Dry run.** A dry-run runtime must virtualize **every** exposure path: `broadcast` and `release`,
  answered from the multi-step simulation backend and a stub API. It uses an isolated ledger
  directory, and it must sign with a key that is not the production key, so no usable production
  signature can reach an external party. The reducer is unchanged.
- **Partial `setConsumed`, unratify, and `cancelRoot` as neutralizers.** They are refused until
  modeled.
- **Multiple providers per role and quorum reads.** One provider per role, with block-hash pinning.
- **The saga coordinator itself** (§13.2).

## 15. Residual risks

- **Recovery's limits are per process.** A restart starts every loaded entry's `recoveryAttempts`
  at zero and `recoveryBoundMs` from the new recovery, so a process that restarts after each unsafe
  stop retries recovery without a total bound; each neutralizer's fee is still bounded.

- **The event envelope is not validated.** The reducer checks that an event can be cloned, not its
  shape, so a cloneable but malformed event, such as a `Submit` whose `plan` is `null`, throws inside
  the kernel, which stops the runner at once rather than refusing the event.
- **Single ownership is operational.** The ledger store takes no lock and no epoch (§11.5), so two
  processes on one ledger volume, as an overlapping rolling deploy can produce, overwrite each other's
  records, and one's startup read deletes the other's temporaries. Run one replica per volume until
  fencing lands.
- **Validators are the funds boundary for exposure accounting.** A validator that under-reads a
  payload under-reserves and under-records, and no kernel check catches it. The reference validator
  decodes a stand-in encoding. The production one must decode the real ABI and `Payload.decode`
  items, and needs its own adversarial tests.
- **A reorg past the finality rule is not undone.** Final evidence already applied stays applied.
  Choose the finality rule conservatively. A shallow depth on an L2 makes clean stops fast and this
  risk real.
- **A rolled-back ledger is not detected for signature-only exposure.** Only the nonce check guards
  a restored ledger, and a released signature consumes no nonce.
- **Dispatch after the dispatch check is unconditional.** A refusal after the send guard has let the
  bytes go cannot recall the act. `maxDispatchLagMs` bounds how late the check may run.
- **The commit-point cumulative consumption check is defense in depth.** Admission and allocation
  make it unreachable today, and the reversion pass shows removing it breaks no trace.
- **Foreign transactions are never contested.** A foreign pending transaction may execute anything
  the key can. The kernel halts and reports it, and resolution waits on positive identification.
- **`revokeAfterStaleMs` bounds how long a wedged engine leaves offers live.** Setting it long trades
  churn for exposure.
- **A failed bot graph halts the kernel; a failed kernel cannot withdraw anything.** The kernel is
  its graph's recovery: when any other operator or effect throws, the runner stops the rest, the
  kernel halts and runs on alone until it stops. A throw inside the kernel stops the runner at once,
  and what it holds waits for its onchain expiry or the next start's adoption.
- **A delegation signed before the kernel owned the key can still be submitted.** The kernel refuses
  to start on an account with code and signs only what a validator claims, and no reference
  validator claims an EIP-7702 authorization; the kernel itself has no check for one. Anyone may
  submit one the account signed earlier. A kernel's account must never have signed one.
- **Retired entries stay in memory until the process restarts.** Terminal plans that nothing names
  are dropped after each event, but a retirement is not, so a late observation of a retired
  commitment never lands on a new one with the same id. Its id stays refused and memory grows with
  offers retired since the last start (they are never durable, so a restart clears them).
- **The reducer is tested, not proved.** Its traces are checked by a mutation pass kept beside them
  (`pnpm --filter @repo/kernel run mutate`): every single-guard mutation in
  [`scripts/mutations.ts`](./scripts/mutations.ts) is caught by a trace or, where it names the guard
  that covers it, once that cover is disabled too.

## 16. Traces

The adversarial traces live in [`test/`](./test), one vitest file per behaviour rather than per
section: plans, fees, nonces, reorgs, restarts, crash boundaries, the ledger and its store, and the
hosted kernel on a fake chain (`host.test.ts`) and on anvil (`host.anvil.test.ts`). A trace this spec
names by quotation is the title, or the start of the title, of a test or `describe` block in one of
them.
