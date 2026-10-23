# Controller library: specification

Status: the specification of `@repo/controller`, subordinate to ADR-2026-10-07, "Bot sources write
levels and occurrences, and the kernel authorizes against declared evidence", and ADR-2026-09-30, "A
bot's key is used only through its kernel".

- [`src/`](./src) is the executable form of this document: plain folds, maps and effects declared
  on `@repo/engine`, and pure constructors of what `@repo/kernel` takes. Where the prose and the
  code disagree, the code is wrong or the prose is. Either way it is a bug in this spec.
- [`test/`](./test) holds the scenario tests (§15).
- Run them with `pnpm --filter @repo/controller run test` and
  `pnpm --filter @repo/controller run typecheck`.

The controller is a library over the kernel, not a layer between the bot and it. It builds the
plans and advances the kernel admits, decides which key is prepared and submitted next, and keeps
the retry state the kernel does not. It holds no key, signs nothing, and judges no evidence beyond
checking that it is well-formed and avoiding what the kernel is sure to refuse (§13): every act it
submits is judged by the kernel under `framework/kernel/SPEC.md` §4.4, and this document only says
what the controller sends and when. Everything here resets on restart (§12).

## 1. Identities

| Identity  | Form                                                      | Scope and lifetime                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key       | the bot's own string, a position or a market              | What a task family prepares for, what the view holds busy, what backoff waits on. A key may hold `#`; a key named like a property every object inherits is read as an own field everywhere ("keys named like the fields every object inherits", "are prepared and submitted like any other").                                                                                                                                                  |
| run id    | `runIdAt(now)`: the time in base 36 and four random bytes | Names every intent id a run issues. Two runs started on one clock reading differ but for a chance collision of the random bytes. A run id holding `.` or `#` is refused when a family is built.                                                                                                                                                                                                                                                |
| intent id | `${key}#${runId}.${n}[.${task}]`, by `intentIdOf`         | Opaque to the kernel. `parseIntentId` reads it back from its last `#`, so a key may hold one; a `task` is non-empty and holds no `.` or `#`. Any other string parses to nothing, and the library then treats the act as one it did not write ("round-trip the key and run, and reject anything else"); one written raw in this form is read as the library's. `n` counts every intent id and preparation ticket of the family in one sequence. |
| ticket    | `${runId}.p${n}`                                          | One preparation request. Its answer is taken only while the ticket is the key's outstanding one and names the fact version the ticket was asked at (§5.4).                                                                                                                                                                                                                                                                                     |
| fact id   | `${node}/${key}`, the kernel's `factId`                   | One key of a registered fact node. Registered node ids may not hold `/`; keys may, so the first `/` is unambiguous ("refuses a registered fact node holding /", "keeps / in a fact key after its registered node separator"). The guarantee applies to registered nodes, not arbitrary strings passed to `factId`.                                                                                                                             |
| task name | a string holding no `.` or `#`                            | Names one kind of act of a key. Backoff, declines and stale holds are kept per key and task (§6).                                                                                                                                                                                                                                                                                                                                              |

## 2. Evidence: readings, plans and advances

The kernel admits plans and advances; the controller is the only code that builds ones carrying
evidence. The types enforce it: `KernelRequest` takes a `Submit` plan or an `Advance` only with the
`Authored` brand that `act`, `withdrawal` and `advance` put on their results, so a hand-built plan,
a hand-built advance, a withdrawal relabelled as an advance, and a reading of another kernel are
refused at compile time ("the types of a plan", "refuse a hand-built plan, and a fact of another
kernel"). `factOf` freezes a reading, its fact and its basis ("freezes a reading's fact and basis").
The request constructors freeze their returned top level; a return can share nested objects with
its inputs until the engine accepts the request, when the engine freezes it to any depth (engine
SPEC §1.1; "cannot be changed after it is built, nor can the readings it rests on").

### 2.1 Fact registry

`kernelDomain(name)` is one kernel's registry. `fact(node)` registers a keyed node and brands it a
`FactNode` of that domain; a node already registered, with this domain or any other, is refused.
`facts()` returns the list and seals it, and a registration after that is refused ("refuses a fact
registered with a second kernel, or after its kernel took its facts"). `defineBot` hands the sealed
list to the kernel when the declaration returns (§8), so no plan can rest on a fact the kernel does
not observe.

### 2.2 `factOf`

`factOf(node, keyed, key)` is the evidence that `key` of a fact node reads as it does now, or
`undefined`:

- `undefined` when the node has no value, or the key is `unknown` or `failed`, which authorizes
  nothing ("gives no evidence for a key that is unknown or failed").
- Otherwise `{ fact: { id, version, basis }, expiry? }`, frozen through its `basis` (§2). `version` is the key's digest when
  present and the kernel's `ABSENT` when absent, so an absence is evidence too: a key read as gone,
  implied gone by a complete read, or projected gone by the map carries the expiry of the read that
  found it ("reports the expiry of a key read as gone, implied gone, or projected gone"), and none
  when that read named none ("reports no expiry for an absence whose read named none").
- `basis` is the chain read's `{ block, blockHash }` ("carries a chain read basis into the fact, so
  the kernel can refuse orphaned evidence"). A basis that is not an object with a non-negative safe
  integer `block` and a string `blockHash` throws `EvidenceDefectError` ("refuses a key read at a
  basis that names no block").

A reading is identified by object identity: `act` and `advance` accept only a reading `factOf`
made, from a node registered with their domain ("refuses a reading factOf did not make from one of
its own facts").

### 2.3 `act`

`act(domain, { intentId, steps, conflicts, restsOn, readAt?, validUntil?, submissionId?,
supersedes?, maxSpendWei?, decision? })` builds a `PlanInput`:

- `evidence` is every reading's `fact`, in the order given ("rests on every fact it read, in
  order"). `restsOn` must name at least one ("refuses to rest on no fact").
- `basisBlock` is the greatest of `readAt` and every fact's block ("is based at the latest block
  of its facts and of anything else it read").
- `notAfter` is the least of `validUntil` and every fact's expiry ("stops at the earliest of its own
  validity and every fact it read"). Grounds naming no deadline at all throw `EvidenceDefectError`
  ("refuses grounds that name no deadline"), so a plan on an unbounded fact needs a `validUntil`.
- `conflicts` is mandatory, and left off the plan when it names nothing, which the kernel reads the
  same as none ("names its conflicts as given, and none when they name nothing").
- `submissionId`, `supersedes`, `maxSpendWei` and `decision` pass through ("passes its submission
  id and decision through untouched").

### 2.4 `withdrawal`

`withdrawal(domain, { intentId, steps, conflicts, basisBlock, expiresAt, … })` builds a plan with no
`evidence`, `basisBlock` as given and `notAfter = expiresAt` ("rests on nothing, at the block it was
decided at"). It names its own deadline because it rests on no fact; the kernel never refuses a
risk-reducing plan for evidence (kernel SPEC §4.4), and one that is not risk-reducing still passes
every other kernel check: policy, validators, conflicts, lifecycle, capacity, basis and deadline.

### 2.5 `advance`

`advance(domain, { intentId, stage, restsOn, readAt? })` builds `Advance{intentId, stage,
basisBlock, evidence, notAfter}` by the rules of §2.3 ("rests on its stage facts, based after the
plan its stage continues"), so `readAt` set to the plan's last inclusion bases the advance after
the effect its stage continues.

## 3. The kernel view

`declareView(g, id, state)` is a map over the kernel's state; `defineBot` declares it as
`kernel.view`. `viewOf(state)` is pure:

- `busy` is every key, sorted, that an intent id names on an unresolved nonce record's candidate,
  an executing plan, or an unretired entry, `revoking` and adopted ones included ("holds a key busy
  on every entry that carries risk, revoking and adopted ones included"; "holds a key busy on an
  unresolved send or an executing plan, and reserves each once"). An intent id that does not parse
  (§1), the kernel's own recovery plans included, names no key and holds none busy.
- `numReservations` is the number of unresolved nonce records plus the executing plans no nonce
  record names at all, so a plan whose transaction is pending is counted once ("holds a key busy on
  an unresolved send or an executing plan, and reserves each once").
- `acceptingNewWork` is true only while the kernel is `running` and not latched ("accepts new work
  only while running and not latched on an unresolved send").
- `conflictMarks` is the kernel's own (kernel SPEC §4.4) (untested).

`isBusy(view, key)` reads `busy`, and is false with no view ("holds a key busy on every entry that
carries risk, revoking and adopted ones included" reads it through `isBusy`; no view is untested).

## 4. Backoff

`declareBackoff(g, id, { runId, prepared, activity, heads, policy })` is the fold `id` with the
events node `${id}.events`. `policy` is `{ baseBlocks, maxBlocks }`, each a whole number from 1,
checked when the fold is declared ("is refused at build with a bound that is not a whole number of
blocks").

- Its clock is the newest head number it has seen; a head below it is ignored (untested).
- State is per key and per task. A failure at `(key, task)` sets
  `until = block + min(baseBlocks · 2^min(failures − 1, 32), maxBlocks)` with `failures` one more
  than before ("doubles the wait on each consecutive failure, up to the maximum"). The key's task
  waits while `block < until`. An entry whose `until + maxBlocks` is at or below the current block is
  forgotten, so an entry lives at most that long; the number of keys and tasks held is not bounded
  ("never holds a key past its wait, and forgets it, however many times it failed").
- A failure is one of:
  - a `PrepareResult` that is `ok: false` with `backoff: true`, at the key and task it names,
    whether or not its ticket is still outstanding in the family: backoff is independent of whether
    the answer's ticket is still current ("backoff is independent of whether the answer's ticket is
    still current");
  - a kernel notice `refused`, `abandoned`, `compensating` or `failed` whose intent id parses (§1),
    at the key and task it names, except: a refusal whose code is `evidence_expired`,
    `evidence_too_old`, `evidence_predates_own_effect` or `decision_predates_own_effect`, which a
    fresh read may pass and which sets no backoff ("waits out no backoff for an act refused on
    stale evidence" covers all but `evidence_too_old`); and an `abandoned` or `compensating` notice for an intent id of another run,
    which ended because that run stopped ("backs off an earlier run's act that failed, but not one
    it abandoned or a restart withdrew"). An intent id naming no task backs the key off under the
    untasked slot, which every task of the key heeds ("backs off only the task whose act the
    kernel ended unsettled").
- A `settled` notice clears the entry at its intent id's key and task, and only that one ("keeps
  each task of a key on its own backoff, and a settlement clears only its own").
- `isBackedOff(backoff, key, task)` is whether the task's own entry or the key's untasked entry
  holds; with no task, whether any entry of the key holds; with no backoff state, false ("keeps each
  task of a key on its own backoff, and a settlement clears only its own"; "backs off only the task
  whose act the kernel ended unsettled"; no backoff state is untested).
- Backoff is not persisted (§12) (review).

`logBackoff` logs `backoff.set` and `backoff.cleared` with the key as `id`. Log shapes are not a
contract (`docs/CONVENTIONS.md`), so none is pinned (untested).

## 5. Task families

`tasks.each(b, id, { kernel, candidates, facts, inputs, runId, maxReservations, backoff, policy,
prepare })` declares, in the scope `id`: `${id}.requests`, which the kernel takes; `${id}.prepared`;
the backoff fold `${id}.backoff` (§4); the family fold `id` with `${id}.prepare` and `${id}.events`;
and the preparation effect `${id}.preparation`. It returns `state`, `events`, `backoff`, `requests`
and `prepared` (untested).

Refused when built: a second family on the same kernel (§9); `prepare.timeoutMs` that is not a
whole number of milliseconds from 1 to 2³¹ − 1 ("is refused at build without a timeout it can arm");
`maxReservations` that is not a whole number from 0 ("is refused at build without a reservation cap
it can reach"); a `runId` that its intent ids cannot be parsed back to, one holding `.` or `#` ("is
refused at build with a runId its intent ids cannot be parsed back to"); and a fact the kernel's
transitions can trigger (§7).

### 5.1 Inputs and the decision

The family fold watches `candidates`, `facts`, `inputs`, the kernel view and the backoff state, and
takes every `prepared` answer and every batch of kernel activity. Each evaluation first applies every
input delivered to it, then decides once, at the step's time:

1. Every present candidate's `policy(candidate, key)` is read, once per decision (§5.2) (untested).
2. Every ready act is checked against `heldDrop` and dropped on the first reason that holds (§5.5)
   ("drops a prepared act it was holding, and submits only a fresh one"; "drops the old ready act
   and submits only a preparation of the new task"; the order of the reasons is untested).
3. Only while `view.acceptingNewWork` is true: ready acts are submitted in rank order (§5.3), then
   preparations are asked for in rank order (§5.3). While it is false, ready acts are held, not
   dropped ("drops the old ready act and submits only a preparation of the new task" holds a ready
   act through a false view; the rest is untested).
4. Declines and stale holds whose fingerprints no longer match the current inputs are forgotten
   (§5.6) ("is prepared again when only its input changes, and not when nothing does"; "is prepared
   again on the next read of its fact, not before, and backs nothing off").

Rank order is priority descending; among equal priorities, keys in string order starting after the
key served last, so equal priorities take turns ("prepares and submits by priority, resting each
act on its key" shows the preparation order and the key each act rests on).

### 5.2 The policy

`task(name, { priority, conflicts })` validates once and freezes: `name` a string holding no `.` or
`#`, `priority` a bigint, `conflicts` an object whose `reads` and `writes`, if present, are lists
of strings. Anything else throws `TaskDefectError`. The runtime acts only on an object `task`
built, read as it was built and never through its spec again ("acts on the task as it was read,
never reading its spec again").

A policy that throws is `policy_threw`; one that throws `TaskDefectError` or returns anything
`task` did not build is `policy_invalid`. Either rejects that key alone: the key acts on nothing
until its policy returns a task again, an `act.rejected` event is logged once per change of reason,
and the bot runs on ("fails only its key, with a named rejection, and the bot runs on"). While
rejected, the key's ready act is dropped as `policy_rejected`, and its outstanding preparation is
voided: it keeps its lane slot until it answers, and its answer never becomes ready, so only a
preparation asked after the policy is valid again is ever submitted ("never submits what was
prepared before, only a preparation asked after it reopens"; "keeps a voided ticket in its lane
after the policy recovers"; "drops a prepared act it was holding, and submits only a fresh one").

### 5.3 Admission

A key is prepared only when all of these hold: its policy returned a task; its fact is `present`
and not past its expiry; its input is `present`; the task is not declined on these same inputs
(§5.6); the task is not held stale on this same reading (§5.6); its reading is not before the
kernel's mark on any conflict id the task reads or writes (§5.7); the key is not busy, where busy is
the view's `busy` or an act of the family's own awaiting its first notice (§5.4); it has no
preparation outstanding and no ready act; and neither the task nor the key's untasked slot is
backed off. An absent key is evidence (§2.2) but is never prepared on ("fails only its key, with a
named rejection, and the bot runs on"; "drops an act whose fact expired, and prepares none on it
after a failed read"; "is prepared again when only its input changes, and not when nothing does";
"is prepared again on the next read of its fact, not before, and backs nothing off"; "is not
prepared until its fact is read at or after that effect"; "keep independent backoff: a task backed
off never holds the other"; a busy key, an outstanding or ready act, and an absent key are
untested).

Then, in rank order, a preparation is asked for while the number outstanding is below the lane's
concurrency and `numReservations + outstanding + ready` is below `maxReservations`, where
`numReservations` is the view's plus the family's own acts awaiting a notice ("prepares and submits
by priority, resting each act on its key" shows the lane bound; the reservation cap is untested).

A ready act is submitted, in rank order, while `numReservations` is below `maxReservations`, and
only if its key is not busy and its task is not backed off; rank, the cap, busy and backoff are
re-checked here, the lane, declines, stale holds and own effects are not, and the kernel judges. A
ready act whose key backed off after it was prepared, after an act the bot wrote raw, waits and is
then submitted as prepared ("is held, not submitted, until the backoff ends, and then submitted as
prepared").

### 5.4 Preparation and its answer

A preparation request is `{ id: ticket, key, task, seq, version, input }`: `version` the key's fact
version and `input` the key's input value, both captured in the decision that asked. The family
keeps the key's `FactReading`, its input fingerprint, its task and the task's conflicts beside the
ticket. The effect names each request by its ticket and sequences by `seq` ("stamps the adapter
outcome itself and keeps evidence from its own captured reading" shows the reading kept beside the
ticket; the request's `input` is untested).

The handler gets `{ signal }` and returns a `PrepareOutcome`: `{ ok: true, steps, validUntil }` or
`{ ok: false, reason, backoff }`. The runtime stamps the outcome with the request's `id`, `key`,
`task` and `version` before writing it to `${id}.prepared`, whatever the handler put in it ("stamps
the adapter outcome itself and keeps evidence from its own captured reading").

The family takes an answer only when its `id` is the key's outstanding ticket and its `version` is
the version that ticket was asked at; any other answer changes nothing in the family and releases
no slot, though backoff and the fault log still read it (§4, §14) ("ignores stale tickets, foreign
keys and wrong versions without releasing the lane"). An `ok`
answer to a live ticket makes the key ready. An `ok: false` answer with `backoff: false` to a live
ticket is a decline (§5.6). An answer to a voided ticket frees the key's slot in the family and
readies nothing; a fault answer still logs and backs off (§4), since those read every answer.

The runtime answers for a handler that throws, as `prepare_threw` with `error` the thrown value's
class name and never its message or `name` ("backs off a key whose handler throws, naming only the
error, and runs on"), and for one still running at `timeoutMs`, as `prepare_timed_out`; both carry
`backoff: true` and log `act.prepare_failed`; a timeout also aborts the handler's `signal`, a throw
does not. The runtime stops
waiting at the timeout whether or not the handler heeds the signal, so a hung handler holds its lane
slot no longer than `timeoutMs` ("times out a handler that ignores its signal, freeing its slot and
backing its key off"). On stop the signal aborts and the runtime writes nothing, so a hung
preparation never blocks a clean stop ("lets a clean stop settle with a hung preparation in
flight").

A submitted act rests on the reading captured when the preparation was asked: its evidence, basis
and expiry come from that reading, never from a later read of the same key, even at the same value.
The kernel therefore refuses it once the block it was read at is orphaned, and admits it when the
fact was only read again at a newer canonical block ("rests on the read it was prepared from, so
the kernel refuses it once that block is orphaned"; "still goes once its fact was only read again
at a newer canonical block"). The plan is `act(domain, { intentId, steps, restsOn: [reading],
validUntil, conflicts, decision: { key, priority, prepared: ticket } })`, with the conflicts the
task declared when the preparation was asked.

`act.submitted` means the family sent `Submit`, not that the kernel admitted it. The family holds the
act as busy and reserved until the kernel's first notice for its intent id; after that the view
says ("prepares and submits by priority, resting each act on its key" logs it against a kernel
that never answers; the hold until the first notice is untested).

### 5.5 Drop reasons

Every reason a ready act is discarded is one of two ordered checks, each taken at the first reason
that holds:

| When                              | Order                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| every decision (`heldDrop`)       | `preparation_expired` (`validUntil ≤ now`), `not_candidate`, `policy_rejected`, `task_changed` (another name, or the same name with other conflicts)                           |
| as it is submitted (`submitDrop`) | `fact_unavailable` (no reading now), `fact_unbounded` (the captured reading has no expiry), `fact_expired` (captured expiry `≤ now`), `fact_changed` (the version now differs) |

Each logs `act.dropped` `{ id, task, reason }`, and `fact_unbounded` also names its `fact`. A task
that keeps its name but declares other conflicts is `task_changed`, so an act always carries the
conflicts it was prepared under ("drops the old ready act and submits only a preparation of the new
task"; "drops a ready act whose task keeps its name but changes its conflicts"; "drops an answer
whose captured version no longer matches the current fact"; "drops an act on a fact with no expiry,
naming it, until its inputs change"; "drops an act whose fact expired, and prepares none on it after
a failed read").

### 5.6 Declines and stale holds

A decline is keyed by the digests of the key's candidate, fact and input at the time the
preparation was asked. The task is not prepared again until one of them changes ("is prepared again
when only its input changes, and not when nothing does"). A `fact_unbounded` drop records a decline
too. A decline is forgotten once the fingerprint differs from the current one, and a voided
ticket's answer records none.

A stale hold is set when the kernel refuses a submitted act with a stale-evidence code (§4), keyed by
the reading the act rested on: version, block hash and expiry. The task is not prepared again until
the fact's reading differs, by a new version, block hash or expiry, or by the fact becoming
unavailable in between; it sets no backoff ("is prepared again on the next read of its fact, not
before, and backs nothing off" shows a new expiry).

### 5.7 Own effects

A task is not prepared while its fact was read at a block below the view's `conflictMarks` entry
for any id the task reads or writes ("is not prepared until its fact is read at or after that
effect"). The kernel would refuse the act as predating our own effect (kernel SPEC §4.4), so the
runtime waits for the next read at or after that block instead of submitting and backing off.

### 5.8 Logs

`logTasks` logs each event as `act.${type}` with its key as `id`, at warn for `rejected` and
`prepare_failed` and info otherwise. Log shapes are not a contract (`docs/CONVENTIONS.md`), so none
is pinned (untested).

## 6. Tasks of one key

A key's backoff, declines and stale holds are kept per task, its intent ids carry the task, and it
acts on one task at a time: while any task of the key is outstanding, ready or busy, no other is
prepared. A task backed off never holds another of the same key ("keep independent backoff: a task
backed off never holds the other"), while an untasked act's failure holds them all (§4).

## 7. A fact the kernel must not trigger

`defineBot` refuses, when the graph is built, a family whose fact any write of the kernel's `state`,
`activity` or `commands` can lead the runner to write. Reachability is over declared edges, emits and
results, skipping the kernel's own recovery scope: a `latest`, `watch` or `every` edge schedules its
reader; a `sample` of a node with no initial value schedules it once at the node's first write; an
`every` request starts an effect, and so does any sample of an effect that has a `ready`, since the
runner re-checks `ready` against every sample. The refusal names the path ("is refused at build when
a kernel transition can trigger it"; "is refused at build when it samples a kernel node with no
initial value"; "is refused when its ready waits on a kernel sample").

What is allowed: a `sample` of a kernel node with an initial value, a kernel node named only as a
`sample` request of an effect without `ready` ("builds when it names a kernel node only as a sample
request, which is never delivered"; "is allowed when only its handler reads the kernel sample"). A
fact read this way moves only when something outside the kernel triggers it, so the act's own
admission never moves its evidence and the kernel never withdraws it for that ("read by sample, is
acted on once: its own admission never moves its evidence").

## 8. `defineBot`

`defineBot(id, declare)(options)` builds the graph `id` and returns the declaration's handles with
it. Every helper but `raw` declares plain engine nodes under the ids below, so anything it does can
be written raw instead (review).

- `b.kernel(options)` is `declareKernelHost` plus the view `kernel.view`. It is declared once; a
  second is refused. Its `requests` option names the nodes besides the task family's that write the
  kernel ("takes the requests b.kernel was given beside the family"). Once the declaration returns,
  the kernel is attached over the family's requests, those nodes, and the domain's sealed facts
  (§2.1), and the graph is built; a family that reaches the kernel after that is refused ("refuses
  a family that reaches the kernel after the declaration returned"). A fact may be declared after
  the kernel's view was read ("acts on a fact declared after the view was read, sampling the kernel
  state").
- `b.source(id, { level, at, queue, validForMs, read })` is the effect `id` on the lane `id`, one
  read at a time with `queue` waiting, writing `${id}.reads`, folded by `keyedLevel` into `level`.
  `validForMs` must be a positive safe integer ("refuses a validForMs that is not a positive safe
  integer"). A `complete` or `carried` write expires no later than `validForMs` after the read
  started, keeping its own expiry when that comes first ("expires each read validForMs after the
  read started, not after it landed"; "keeps a %s read its own expiry when that comes first" for each of "complete", "carried"); a failed write is passed as is.
  With `at: 'head'`, a read is requested at every kernel head and skipped when the kernel's head no
  longer has that number and hash when the read starts ("skips a queued head the kernel replaced at
  the same height"), so a newer head's read always lands last ("lands a newer head last even when an
  older read is slower"). With `at: { everyMs }`, the fold `${level}.interval` emits `${level}.due`
  on the first head delivered once the last read landed and `everyMs` has passed since it started;
  the read then runs at the kernel's current head. A throw from `read` fails the graph, as any
  effect's does.
- `b.fact(id, over, project, options)` is `keyedMap` registered with the kernel's domain;
  `b.derive` is `keyedMap` alone (untested).
- `b.sink(id, { on, samples, finishOnStop, handle })` is the effect `id` requested by every write of
  each node in `on`; an async handler's rejection fails the graph ("fails the graph when its async
  handler rejects").
- `b.raw(body)` hands `body` the engine's builder ("refuses a second task family on a kernel the
  bot hosts raw" hosts the kernel on it).

## 9. One kernel, one family

A family counts its own reservations, holds its own submissions awaiting a notice and numbers its
own intents, so two on one kernel would prepare against the same capacity unseen and could reuse
intent ids. `tasks.each` keys the family by the kernel's `kernel.state` handle object (§14), which
no other handle stands in for, and refuses a second however the kernel is reached: through
`b.kernel`'s handle or a copy of it, a kernel hosted raw, or a node named to `requestsFrom` directly ("refuses a second task
family on one kernel, naming why, however its handle is reached"; "refuses a second task family on
a kernel the bot hosts raw"; "refuses a second family named to the kernel directly").

## 10. Workflows

`declareWorkflow(g, id, { domain, state, facts, requests })` is the fold `id` with `${id}.events`,
watching the kernel's state and every fact node named. For each executing plan parked
`awaiting-advance`, it sends one `Advance` when every fact the plan's evidence names reads now, from
a node in `facts`, at the version the plan was decided on, with an expiry, at a block at or after the
plan's last inclusion; the advance is based at or after that inclusion and carries the plan's
`decision`
("advances a parked stage once its decision reads the same after its own inclusion"). The same
evidence, by stage and by each fact's version, basis and expiry, is never sent twice for one plan; a
renewed expiry is new evidence, so an advance the kernel stalled on expired evidence is sent again
once the facts are read anew ("advances again once evidence that expired before its advance is
renewed").

A fact that moved, is unavailable, carries no expiry, was read before the inclusion, or names a node
not in `facts` leaves the plan parked ("leaves a stage parked once its decision moved, so
publication is never authorized"); the plan then ends at its finished stage's deadline, by the
bot's supersession, or with a halt, stop or other kernel transition that fails it (kernel SPEC §4.3,
§10). A plan with no evidence is never advanced here. When a fact node becomes
unavailable as a whole, its last value is forgotten, so no advance rests on it ("forgets a fact
whose node becomes unavailable, so no advance rests on its last value"). Nothing here is a second
store of the workflow: it reads the kernel's plans, and the kernel judges every advance.

`${id}.events` carries `{ intentId, stage, block }` per advance sent ("advances a parked stage once
its decision reads the same after its own inclusion"). No log helper is provided.

## 11. Halt policies

`declareHaltPolicy(g, id, { over, requests, initial, applyInput })` is the fold `id` over every
write of `over`. `applyInput(state, value)` returns `{ state, halt? }`; the first step naming a
`halt` emits `Halt{reason}` to `requests` once, and every later input is ignored ("requests a halt
once its policy calls for it, and only once"). Its state replays with the graph and resets on
restart.

## 12. Restart

Nothing in this library is persisted. A restart starts every fold at its initial value: backoff,
declines, stale holds, the halt latch and the workflow's sent record reset; the family's intent
count starts again under the run id the bot passes, which must be new to the process (`runIdAt`)
or intent ids and tickets repeat; an entry the kernel adopts keeps its key busy through the
view; and a notice for an earlier run's act is read as §4 says ("backs off after a restart when
that act fails, though nothing was carried over").

## 13. What is deliberately left out

- **Evidence judgement.** The controller reads a fact's presence, version and expiry, its own
  reservation cap and the kernel's conflict marks only to avoid asking for what the kernel is sure
  to refuse (§5.3, §5.5, §5.7); canonicality, evidence age, inter-plan conflicts and kernel capacity
  it never judges. The kernel's checks are the authority (kernel SPEC §4.4).
- **Truthful coverage and pinned reads.** `b.source` bounds a read's expiry and orders its reads;
  whether a read walked its whole scope or pinned its block hash is the adapter's, shown by its own
  tests and review.
- **Persistence.** Backoff across restarts, a durable workflow record, and a saga rebuilt from
  `submissionId` are not provided.
- **A bound on a `with` input's influence on a fact.** Nothing checks that a `with` input is not
  what makes an act safe; review does.

## 14. Residual risks

- **A policy runs for every candidate at every decision.** An expensive or impure policy slows or
  destabilizes every family decision, and nothing bounds it.
- **A voided ticket holds its lane slot until it answers**, up to `timeoutMs`. A policy that flaps
  while preparations are slow starves the lane.
- **A decline keyed on a churning input retries on every read.** The key's throttle is the
  handler's `backoff: true`, or keeping what churns out of `inputs`.
- **An untasked act's failure holds every task of its key** for as long as its backoff, so a raw act
  of a key can hold the family's tasks on it.
- **The one-family guard keys on the `kernel.state` handle's identity.** A copy of that handle
  object presents a second kernel to `tasks.each`, and two families then count capacity apart.

## 15. Traces

The scenario tests live in [`test/`](./test), one vitest file per module: `act`, `backoff`, `bot`,
`halt-policy`, `intent`, `log`, `tasks`, `view` and `workflow`. A trace this spec names by quotation
is the title, or the start of the title, of a test or `describe` block in one of them, joined to its
`describe` where the sentence needs it. The randomized model in
[`framework/tests/`](../tests/) drives a toy bot built from this library under random schedules of
faults and holds.
