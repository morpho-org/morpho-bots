# Dataflow engine: specification

Status: the specification of `@repo/engine`, subordinate to ADR-2026-10-07, "Bot sources write
levels and occurrences, and the kernel authorizes against declared evidence", and ADR-2026-09-30,
"Every step is journaled; only operator logs are sampled".

- [`src/`](./src) is the executable form of this document: a graph builder (`graph.ts`), one step
  of propagation (`core.ts`), the runner that schedules steps and effects (`runner.ts`), keyed
  levels (`keyed.ts`), the journal entries (`journal.ts`) and their replay (`replay.ts`). Where the
  prose and the code disagree, the code is wrong or the prose is. Either way it is a bug in this
  spec.
- [`test/`](./test) holds the scenario tests as vitest tests (§16).
- Run them with `pnpm --filter @repo/engine run test` and `pnpm --filter @repo/engine run typecheck`.

The engine builds and runs one static graph of data nodes, pure operators and effects. It knows no
chains and no kernel: it has no runtime dependencies (§13). It never undoes a write, never infers
absence, and never rewinds. Authorizing an act is not its job; it carries evidence to the code that
does.

## 1. Values and nodes

### 1.1 Data

A node holds `Data`: JSON plus `bigint`. `encode` gives a value one canonical text, with object
fields sorted and `undefined` fields dropped, so `encode(a) === encode(b)` exactly when `a` and `b`
are the same data; `decode` reads it back, bigints included. A bigint is written as
`{"$bigint": "<digits>"}`, so the field `$bigint` is reserved. Anything else is refused with
`NotDataError`: `NaN` and the infinities, functions, `undefined` inside a list, and any object that
is not a plain object, including `Map`, `Set`, `Date` and class instances (§15 for what `encode`
cannot see). Traces: "encodes equal data identically whatever the field order", "drops undefined
fields", "round-trips bigints", "tells a bigint from the same digits as a number or string", the
"encode" block's "refuses" cases (a `Map`, a `Date`, `NaN`, a function, `undefined` in a list, the
reserved field) and the "fold state" block's "refuses" cases (a `Set`, a class instance).

Every value a node carries is checked against `encode` as it is accepted: a push that is not
data throws before it is queued (but a level write whose `value` is `undefined`, §15); a fold
state, map output or emit that is not data fails the step (§5) and so the graph, leaving the state
the operator had (the "fold state" block's "refuses" cases); an
effect result that is not data throws into the handler that wrote it; a clock value that is not
data fails the graph at the clock; and a note that is not data throws into the handler that made it
("refuses a note that is not data at note time").

Every value a node holds is frozen, to any depth, when it is accepted, produced or derived, so a
reader cannot change what another reader, the journal or a later step sees ("hands out frozen
values, so a reader cannot change what other readers see", "freezes an accepted write, so its
evidence cannot change after it is read", "hands expiries a frozen value, so they cannot change what
is stored", "hands out records no caller can change").

### 1.2 Node kinds

| Declared by                  | Kind         | Written by                                    | Coalesces | Shape              |
| ---------------------------- | ------------ | --------------------------------------------- | --------- | ------------------ |
| `g.level(id)`                | `level`      | a push of a `LevelWrite` (§1.3)               | no        | `value`            |
| `g.occurrences(id)`          | `occurrence` | a push of any data                            | no        | `stream`           |
| `g.clock(id, {everyMs, …})`  | `clock`      | the runner, every `everyMs` once started      | no        | `stream`           |
| `g.node(id)`                 | `derived`    | one fold's `emits`, or one effect's `results` | no        | `stream`           |
| `g.map(id, …)`               | `derived`    | that map                                      | yes       | `state` or `value` |
| `g.fold(id, …)`, `g.reserve` | `derived`    | that fold                                     | yes       | `state`            |

A **coalescing** node records no write when its status, digest, basis, expiry and reason all equal
the last record. Every other node records every write. Only a non-coalescing node that is not a
level may be read by `every` (§3), which the types enforce too: a `Stream` is a node none of whose
writes coalesce and none of which is unknown or failed; a `State` always holds a value, from its
build-time initial value on (§1.5); a `value` is any other level or map output, which may be
unwritten, unknown or failed ("writes the first real evaluation though it equals the initial value,
and coalesces after").

### 1.3 Records and level writes

`runner.record(node)` is the node's current `NodeRecord`: `status` is `unwritten`, `present`,
`unknown` or `failed`, with `value` and `digest` when it holds a value, and `basis`, `expiry` and
`reason` as the last write carried them. `runner.read(node)` is its value when it holds one, else
`undefined`. A level write is `{ value, basis, expiry? }` or `{ status: 'unknown' | 'failed',
reason? }`: a present write without its basis is refused, and a failed read carries no value, so a
reader downstream sees `failed`, never an empty value ("refuses a level write without its basis,
and refreshes evidence on an equal write", "carries a failed read to its readers as failed, never
as a value"). An equal value with a new basis is recorded and visible, since a level does not
coalesce.

### 1.4 Shapes in the types

`Node<T, Shape>` carries what each write holds and its shape. `every` takes only a `Stream`;
`Samples` of a `State` are never `undefined`, while any other sample is `undefined` until its first
present write and while it is unknown or failed ("types a sample with an initial value as present,
and any other as possibly unwritten"). A map whose every input is a `latest` of a `State` is a
`State`; a map's `expiries` option is typed from what its `compute` returns ("a map's expiries":
"read the value its compute infers").

### 1.5 Initial values

`build()` gives every fold its `initial` value, frozen, and every map whose inputs are all `latest`
edges of nodes with an initial value the value it computes from them, once, in evaluation order,
frozen and checked as data; a fold's initial is checked as data when the runner is created. A map
that throws on them fails the build with `GraphDefinitionError` ("refuses to build a map that fails
on its initial inputs"), and so does one that computes something that is not data. Until
a node with an initial value is first written, every read sees that value and its record is
`unwritten`; nothing is scheduled, stepped or started for it ("reads a map over folds at boot, from
values computed once at build", "runs nothing at boot: no fold steps, no map computes again, no
effect starts"). The first real write to it always lands, even when equal to the initial value, and
later equal writes coalesce ("writes the first real evaluation though it equals the initial value,
and coalesces after"). A map with any other input (a `sample`, an `every`, or a `latest` of a node
without an initial value) has no initial value and reads as `unwritten` with no value; a fold keeps
its `initial` whatever it reads.

## 2. Declaring a graph

`createGraph(id)` returns a builder; `build()` checks the declaration and fixes the evaluation
order. The builder must be treated as consumed afterwards; nothing enforces it (§15). A `Graph`'s layout is keyed by a symbol the package does not export: it is not API, and
`layoutOf` from `@repo/engine/testing` exists only so tests can pin it (review).

- **One producer per node.** A level or occurrence is written by pushes; a clock by the runner; a
  map writes its output; a fold writes its output and its `emits`; an effect writes its `results`.
  A second producer is refused as it is declared, and `build` refuses a node nobody produces
  ("refuses a node with two producers", "refuses a node no producer writes").
- **Handles are the graph's.** A declaration or a push may name a node only by a handle this graph
  created, so a handle from another graph is refused even when its id names a node of this one, and
  so is a push by one ("refuses a read of a node from another graph", "refuses a handle another
  graph created, though its id names a node of this one", "refuses a push by a handle another graph
  created, though the ids match", "refuses a reservation another graph made"). `runner.read` and
  `runner.record` resolve by id alone, so a foreign handle whose id names a node of this graph reads
  it.
- **`every` reads only what records every write.** An `every` edge on a map or fold output, which
  coalesces, or on a level, whose failed writes carry no value, is refused ("refuses an every read
  of a map output, which coalesces equal writes", "refuses an every read of a fold output, which
  coalesces equal writes", "refuses an every read of a level, whose failed writes carry no value");
  one on an occurrence source, a clock or an emitted node builds ("reads every write of an
  occurrence source, a clock and an emitted node").
- **Ids.** A node id is declared once. An effect id is distinct from every other effect's and from
  every operator declared before it; an operator declared after an effect may reuse its id (§15).
  An effect and an operator never collide at run time whatever ids they were declared with, since
  they read through disjoint keys ("refuses two effects with one id", "keeps an effect and an
  operator apart whatever ids they are declared with").
- **Scopes.** `g.scope(prefix, body, options)` runs `body` against a builder that prefixes every id
  it declares with `prefix.`, nested scopes included, and returns what `body` returns ("prefixes
  every id a scope declares"). With `recovery`, the scope is a **recovery scope**: its members are
  exactly the operators, effects and clocks its body declares, nested scopes included, and
  `recovery(result)` gives the `OnFailure` that winds it down (§11). A graph holds at most one, and
  one inside another is refused ("refuses a second recovery scope until a composite stop exists",
  "takes as members exactly what its scope declares", "refuses a recovery scope inside another").
- **Reservations.** `g.reserve(id)` declares a fold's output before the fold, so readers can name
  it first; it reads as the fold's initial value from the start. Only `g.fold(reserved, spec)`
  produces it: an effect's `results`, a fold's `emits`, a map, or a second fold are refused, a fold
  of a handle that was not reserved is refused, and `build` refuses a reservation no fold produced,
  including one whose fold was refused for another reason. A fold of a reservation is typed by the
  reservation alone, and belongs to the recovery scope it is declared in, not the one it was
  reserved in ("a reserved fold output" block).
- **Bounds.** A clock needs a period above zero; nothing more of it is checked. A `lane` needs a
  positive concurrency (a safe integer or `Infinity`), a positive safe-integer queue bound, and, when
  budgeted, a positive safe-integer `calls` and a positive `perMs` ("refuses a budget that could
  never start anything" for zero calls, "refuses bounds that could never start or hold anything" for
  zero or `NaN` concurrency and a zero queue). An effect with
  `finishOnStop` may not declare `ready` ("refuses to wait to be ready, which nothing could change
  after a stop").
- **Evaluation order.** Operators are ordered topologically over every edge they read whose node an
  operator produces, ties and cycles broken by declaration order, so an operator runs after the
  operators it reads whatever the declaration order, and only a feedback edge re-enters an operator
  already evaluated in a step ("evaluates operators after the operators they read, whatever the
  declaration order").

## 3. Edges

| Edge        | The reader gets                                                                            | Schedules the reader                                                              |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `latest(n)` | the newest value when it runs; blocked while `n` is unreadable (§4.1)                      | on every recorded write that changes status, digest, basis, expiry or reason      |
| `sample(n)` | the newest value when it runs; blocked while `n` is unreadable                             | when `n` becomes readable from unreadable; never for a node with an initial value |
| `every(n)`  | each write since it last ran, `{ value, stamp }`, in delivery order, several inputs merged | on every recorded write                                                           |
| `watch(n)`  | `n`'s current record, once per step in which `n` was written, and again at each expiry     | on every recorded write, and on each wake (§6)                                    |

- An `every` input **buffers** each write until its reader takes it. A map whose other inputs leave
  it blocked takes nothing, so the buffer keeps every delivery, without bound, until the map runs
  (untested).
- A `sample` of a node with no initial value schedules its reader at the node's first present
  write, so a reader never waits on a sample forever, and not at a later present write ("runs a
  reader once its sample is first present, and not again when the sample changes"); it schedules it
  again when the node becomes present after being unknown or failed. A later change to the sample is
  read at the next trigger. A `sample` of a node with an initial value never schedules its reader.
- A `watch` reader sees a node once per step however many times the step wrote it, as the record
  stood at the last write, with its status, basis and expiry visible even when the value is equal
  ("sees a level once per step it was written, with its status and basis, merged in order").
- A recorded write to a non-coalescing node whose status, digest and meta all equal the last
  record wakes its `every` and `watch` readers, not its `latest` readers (untested).

## 4. Operators

### 4.1 Maps

`g.map(id, { reads, compute }, { expiries? })` reads `latest`, `sample` and `every` edges. When it
runs, every non-`every` input must be readable: a present write, or an initial value. Otherwise the
map writes its output as `failed` if any such input is failed, else `unknown`, computes nothing,
and leaves its `every` buffers untouched. When all are readable it takes its `every` deliveries and
writes `compute(inputs)` as present. A map with a `sample` of a node that is produced later in the
same step still sees that node first, so breadth over one sample is no cycle ("evaluates a sampled
node before its readers, so breadth over a sample is no cycle").

### 4.2 Folds

`g.fold(id, { reads, emits?, initial, applyInput, afterInputs? }, { expiries? })` reads `every` and
`watch` edges. When it runs it takes every unread `every` delivery and one record per watched node
written since it last ran, merged by write order, and applies `applyInput(state, { from, value,
stamp })` to each in that order; when any input arrived, `afterInputs(state, stamp)` runs once
after them, so a decision reads every input of the step rather than the state between two of them
("decides once per evaluation, after every input that arrived in the step"). It then writes its
state and each emitted value, in order. An emit to a node the fold did not declare in `emits`
fails the step ("stops when an operator emits to a node it does not own").

## 5. A step

A **step** is one external input propagated: a `push`, a `pushAll` burst, a clock tick, an effect's
result, or a wake (§6). The runner stamps it `{ seq, at }`, `seq` counting steps from one and `at`
the runner's `now()`, applies its writes, then evaluates every scheduled operator in evaluation
order until none is scheduled (untested).

- **All or nothing.** When any operator throws, or any write is refused, every record, buffer and
  expiry is restored to what it was before the step, and the error fails the graph at that operator
  ("stops with nothing applied when an operator pushes from inside a step", "fails closed when a
  step re-enters evaluated operators past the cycle bound").
- **Bounded re-entry.** An operator already evaluated in the step may be scheduled again only by a
  feedback edge, at most 64 times, beyond which the step fails with `CycleBoundError`. The bound is
  fixed and shared by live execution and replay ("fails closed when a step re-enters evaluated
  operators past the cycle bound", "replays a finite feedback graph at the fixed cycle bound").
  Breadth and bursts never count: one push of hundreds of writes, or a hundred readers of one node,
  is a single evaluation each ("takes a burst of hundreds of keys in one push without touching the
  cycle bound").
- **Pushes are validated before they are queued.** `push` throws `WriteRefusedError` for a write to
  a node only its producer writes, to a handle from another graph, or that breaks a level's
  contract, and `NotDataError` for a value that is not data; the graph is unchanged ("refuses a push
  into a node only its producer writes, and changes nothing"). A push from inside an operator throws
  `ReentrantPushError`; uncaught, it fails the graph with nothing applied, and an operator that
  catches it still commits its step. A push after the runner finished is ignored.
- **Every derived write lands before any effect starts**, and every emit too ("lands every derived
  write and emit of a step before any effect starts"). A push an effect makes while a step's effects
  are starting is a step of its own, propagated before the next effect starts, so no effect reads
  half-updated state ("runs a push an effect makes while starting only after the step that started
  it", "propagates a push queued during a step before starting any effect of that step").
- `push` returns once its step has propagated and the effects it started have been handed their
  requests, unless it was made while a step was already draining, in which case it is queued behind
  it ("lands every derived write and emit of a step before any effect starts", "runs a push an
  effect makes while starting only after the step that started it").
- While the runner's journal is open, every step that lands is journaled (§9) ("replays a journal's
  stamped steps without running an effect, and finds a step that differs").

## 6. Expiries and wakes

A node's **expiries** are, for a level, its write's own `expiry`; for a map or fold, each number
its `expiries(value)` option finds in a present value, the initial value included. Each must be a
safe integer: a level write carrying anything else is refused by `push`; a derived write carrying
one fails the step, whether or not anyone watches the node and even when the write would otherwise
coalesce; an initial value carrying one fails `createRunner` ("refuses a level write whose own
expiry is not a safe integer", "refuses a write whose expiries hold one that is not a safe
integer", "refuses a write whose expiries are malformed even when it coalesces with the last",
"refuses a graph whose initial value holds an expiry that is not a safe integer"). A negative
expiry is a safe integer and has passed.

The runner **wakes** a node's watchers when an expiry it carries passes, once started:

- Only a node with an active `watch` reader wakes anything; nothing else observes time pass
  (untested).
- A wake is a step with no writes whose `wakes` name the nodes, stamped at the time the runner
  found them due; it hands each node's current record to its watchers again, as at a write, and
  presents every expiry of that node at or before the step's time, so each expiry wakes at most
  once ("wakes its watchers at its expiry with no further write, not at the next unrelated input",
  "wakes the watchers of a value never written yet").
- An expiry a later write replaced wakes nothing; the later one wakes ("wakes nothing at an expiry
  a later read replaced, and wakes at the later one"). Nothing wakes before `runner.start()`
  ("wakes nothing before the runner starts").
- The runner holds one timer, for the earliest unpassed expiry. An expiry that has passed is woken
  before any effect starts, whether its timer fired or the runner found it while starting effects,
  so an effect never samples a fold that has not yet seen the expiry ("that passed before its timer
  fired wakes its watchers before any effect starts", "that passes while effects start wakes its
  watchers before the next one starts").
- A wake is journaled and replayed like any step ("journals the wake as a step of its own, which
  replay reproduces").

## 7. Effects

An effect is the operator meant for side effects; the purity of map, fold, expiry and projection
callbacks is not enforced. `g.effect(id, spec)` declares one over `requests`, a record of
`every` edges; each write to one of them is a **request**. A request is refused while another under its identity is
waiting or running (§7.1); a completed identity is not remembered (§15) ("stops rather than run a
request whose identity is still waiting or running").

### 7.1 Routing and admission

After each step, in declaration order, each effect takes the deliveries on all its request inputs,
merged in write order, so several inputs never become several independently scheduled effects;
each request names the input it came in on ("tells an effect with several inputs which one each
request came in on, in delivery order"). Each is **admitted** in that order:

1. `sequence(request)`, when it returns a position, must exceed the highest position the effect
   admitted so far; otherwise the request is refused ("stops rather than run a completed request
   redelivered below its sequence"). The position is not validated (§15).
2. `identify(request)`, or the delivery's write sequence by default, is its identity. One still
   running under the same identity refuses it ("stops rather than run a request whose identity is
   still waiting or running"), and so does one still waiting. Completed identities are not
   retained.
3. `recovery(request, samples)` marks it recovery work ("holds work past a lane bound and starts
   recovery work first").
4. The lane's queue bound (§7.2) is checked, and the request joins the lane's waiting list ("takes
   a burst up to its free slots plus its queue, and stops rather than skip work past it").

A refusal (`RequestRefusedError`, `LaneOverflowError`, or a lane policy's `PolicyReentryError`)
fails the graph at the effect, after the step that delivered the request has landed and, with a
journal, been journaled; the step is not rolled back (untested).

### 7.2 Lanes

Every effect runs in a `Lane`: the shared default, with unbounded concurrency and a queue of 1,024,
or one it is given. Effects share a lane only when given the same `Lane` object; two lanes with one
name are two lanes. A lane has `concurrency`, a `queue` bound and an optional `budget` (untested).

- **Concurrency.** At most `concurrency` requests of the lane run at once ("holds work past a lane
  bound and starts recovery work first").
- **Recovery first.** When a slot frees, ready recovery work starts before ready normal work
  ("holds work past a lane bound and starts recovery work first").
- **Queue bound.** Admission counts the requests waiting of the request's kind, normal or recovery,
  beyond the lane's free slots at that moment (slots not taken by running work nor, for a normal
  request, by waiting recovery work), or every waiting request of that kind when concurrency is
  unbounded. When that count reaches `queue`, the request is refused with `LaneOverflowError`, and
  the runner stops rather than skip it. Normal and recovery work are counted apart, so a flood of
  normal work never refuses recovery ("admits recovery work into a lane whose normal queue is
  full", "bounds every waiting request of a lane without a concurrency bound", "takes a burst up to
  its free slots plus its queue, and stops rather than skip work past it").
- **Budget.** With `{ calls, perMs }`, at most `calls` normal requests start in any `perMs` window,
  the first burst included; a normal request the budget refuses waits at the front of its lane
  until a start leaves the window. Recovery work starts whatever the budget has left ("starts no
  more than its budget allows in any window, its first burst included", "starts recovery work
  whatever the budget has left").
- **`ready`.** A waiting request starts only when `ready(request, samples)` holds; it is re-checked
  whenever the runner looks for work to start: after every step, after every effect settles, and
  when a budget frees. A request that is not ready keeps its place and its count against the queue
  bound, and does not block a later ready request in its lane ("bounds every waiting request of a
  lane without a concurrency bound").
- Lanes are served in the order their effects were declared (untested).

### 7.3 Starting and the context

No effect starts while a step is pending or an expiry is overdue (§5, §6). A start calls
`handle(request, context)`; its promise settling, or its return, is the request's work done. A throw
or rejection fails the graph at the effect (§11). The context gives:

- `signal`: aborted on stop, abandon, a halt, and, for an effect outside the recovery scope, when the graph
  degrades (§11). Writes made after it are dropped. Work that must land ignores it; stop waits for
  the handler's promise either way (untested).
- `identity`, `stamp` (the stamp of the step that delivered the request), `now()` (untested).
- `samples`: each sampled node's value read when the function is called, not when the request was
  delivered, so a read after an `await` sees later steps ("reads a sample when it is called, so a
  read after an await sees later steps").
- `write(result)`: a step writing `result` to the effect's `results` node, queued like a push;
  ignored once the runner finished or the signal aborted; a `GraphDefinitionError` thrown into the
  handler when the effect declared no `results` (untested).
- `note(note)`: accepts only `Data`, validates it with `encode` and freezes it synchronously, then
  journals it (§9) in order with the steps; ignored once the runner finished ("refuses a note that
  is not data at note time").
- `stop(value)`: a clean stop (§11), ignored from an effect the degrade left inactive ("resolves its
  stop with the value an effect stops it with, after work that must land").

### 7.4 Lane policies

`identify`, `sequence`, `recovery` and `ready` are given the request and the samples to decide
from. One that calls the runner (`push`, `pushAll`, `start`, `abandon`) or any runner context
(`note`, `write`, `stop`) is refused with `PolicyReentryError`, which stands as the graph's failure at that
effect even when the policy caught it, and even when the policy then threw something else ("fails
the graph from the effect, though the policy caught it", "keeps the refusal as the failure when the
policy throws after catching it", "never starts the effect outside a recovery scope it degraded").
`runner.read` and `runner.record` are not refused.

### 7.5 Effects that finish on stop

An effect with `finishOnStop`, for a reporter with no side effect on funds, keeps its queued
requests on a clean stop: they run, with an aborted signal, within the lane's concurrency, and the
stop settles only after them. A halt or an abandon drops them, while a degrade keeps those in the
recovery scope. One started after the stop failing drops the rest and rejects the stop with its
error (§15 for one already running) ("runs its queued requests after a clean stop, before the
stop settles, and drops the rest", "drops its queued requests when a failure stops the runner",
"drops its queued requests when the runner is abandoned", "drops the rest and rejects the stop
with the error when one of them fails").

## 8. Keyed levels and maps

A `Keyed<T, B>` is a level over an open set of keys: `coverage`, whether the latest read of the
whole scope succeeded; `absentBasis` and `absentExpiry`, from the last write that vouched for the
whole scope; and `keys`, each key's `KeyRecord`: `present` with its value, digest, basis and
expiry, `absent` with the basis and expiry of the read that found it gone, or `unknown` or `failed`
with a reason. `keyRecord(keyed, key)` is the key's own record, else absent under the last complete
write, else unknown; it reads only own fields, so a key such as `constructor` is never a false hit
("reads a newly written key at once, and a key no complete write carried as absent"). `UNREAD` is
the value before any write.

`keyedLevel(g, id, writes)` folds `KeyedWrite`s from an occurrence stream, in delivery order:

| Write                                                   | Effect                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete` with `entries`, `basis`, `expiry?`           | replaces every key; coverage `complete`; `absentBasis` and `absentExpiry` set from this write (cleared when it carries no expiry), so every key it omits is absent under it                                                                               |
| `complete` with no entries                              | refused unless `empty: true`; the refusal fails the step and so the graph                                                                                                                                                                                 |
| `carried` with `entries`, `absent?`, `failed?`, `basis` | changes only the keys it names: entries present under its basis and expiry, `absent` ones absent under them, `failed` ones failed; within one write an entry wins over `absent`, which wins over `failed`; coverage and the vouched absence are unchanged |
| `unknown` or `failed` with `keys`                       | sets those keys to that status, with the reason; coverage and every other key unchanged                                                                                                                                                                   |
| `unknown` or `failed` without `keys`                    | sets `coverage` to that status, with the reason; no key changes, so nothing becomes absent                                                                                                                                                                |

Traces: "reads a newly written key at once, and a key no complete write carried as absent", "leaves
every key as it was when the scope read fails, so nothing becomes absent", "changes only the keys a
carried write or a per-key failure names", "stops rather than read an empty complete level nobody
asserted", "accepts an asserted empty level, which makes every key absent", "gives every key a
complete write omits its expiry, and every key a carried write reads as gone", "keeps the absence a
failed or carried read did not replace, and clears an expiry the next complete write lacks".

`keyedMap(g, id, over, project, { with?, expiry? })` is a map over a keyed node:

- It projects each present key with `project(value, key, inputs, { basis, expiry })`, handing the
  projection the basis and expiry the key was read under, typed as the source wrote them ("hands
  each projection the basis and expiry its key was read under, typed as written"). A projection of
  `undefined` makes the key absent under that read, keeping its expiry ("keeps the expiry of the
  read a projected absence came from").
- Coverage, `absentBasis`, `absentExpiry`, and every absent, unknown or failed key pass through
  from `over` alone; a `with` input never changes a key's basis ("passes coverage, failed keys and
  absence through from its keyed input alone", "keeps its keyed input's basis exactly while a
  whole-node input's basis and expiry move").
- A projected key's digest is of the projected value, so it holds while the input moves within the
  projection and across a basis refresh, and moves with the projected value ("keeps a projected
  key at one digest while its input moves within the projection", "keeps one digest across a basis
  refresh, and moves it with the projected value").
- `with` names whole nodes read beside each key, `latest` by default or `sample`; `over` is a
  reserved name ("refuses a whole-node input named after its keyed input"). Being a map (§4.1), it
  is blocked, every key with it, while any `with` input is unknown or failed, whichever edge it is
  read through; a sampled input that fails blocks the next evaluation, not the output already
  written, and a sampled input's change is read at the next trigger ("blocks every key while a
  triggering input is unknown or failed, and recovers once it is present", "re-evaluates on a
  latest input, and leaves a sampled change unread until another trigger", "evaluates once a
  sampled input first becomes present, so it never waits on a sample forever", "blocks the next
  evaluation after a sampled input fails, not the output already written").
- `expiry(value, key, inputs)` returns a deadline for a present projected key, which only ever
  shortens the one it was read under; a result that is not `undefined` or a non-negative safe
  integer fails the step and so the graph ("an expiry option" cases: "shortens its input expiry",
  "never extends its input expiry", "sets an expiry its input lacks", "keeps its input expiry when
  it names none"; "stops rather than project a key whose expiry option is" cases).

Both declare their node's expiries as `absentExpiry` and every key's expiry, so a fold watching a
keyed level or map wakes as each lapses (§6) ("wakes its watchers at its expiry with no further
write, not at the next unrelated input").

The journal writes the first acknowledged complete `KeyedWrite` to a source node in full. A later
complete write to that same node, with no other acknowledged write to it between them, carries only
entries whose encoded value changed and the names of entries removed; its other fields remain
complete. Queued writes retain their complete input and are compacted only against acknowledged
writes ("advances the keyed delta baseline only after an append is acknowledged"). Replay
reconstructs the original complete write
from the run's start, with no snapshot or checkpoint ("replays keyed deltas including a removed key
and a complete write that drops keys").

## 9. The journal

`createRunner(graph, { journal: { sink, capacityBytes, ioTimeoutMs?, describe? } })` journals the
run through `sink.append(entry)`, one entry at a time in order, each append awaited before the next.
Without the option nothing is journaled and nothing else changes; `runner.hasJournal` reports which
kind was created ("exposes whether it has a journal"). Any other value of the option, including a
falsy one, is refused when the runner is created ("refuses a journal option that is not an object").
The runner calls `sink.finalize()` once, with whether the journal remained clean, after no more append
can begin and every accepted append has settled or been discarded after failure ("discards every
queued append after a failed append"). What
each bot must journal, where the journal is stored, its retention, and how operator logs are sampled
from it are decided in ADR-2026-09-30, "Every step is journaled; only operator logs are sampled", and
are not restated here ("waits for a late append rejection after stop and surfaces it").

### 9.1 Entries

`JOURNAL_FORMAT` is `2`. Any change to an entry's shape bumps it; the shape of each shipped format
is pinned so a change cannot ship under an old number ("names the entry shape it writes, so a shape
change cannot ship under an old format").

| Kind       | Fields                                                             | Appended when                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`     | `stamp`, `writes[{ node, value \| delta }]`, `wakes?`, `derived[]` | a step lands, before its effects are routed; full `writes` keep the form pushed, clock values and effect results included; a keyed-complete `delta` has the complete write's other fields, changed entries and removed keys; `derived[{ node, digest }]` carries every derived write in order, the digest being the value's or status |
| `note`     | `effect`, `at`, `note`                                             | an effect calls `context.note`, in order with the steps                                                                                                                                                                                                                                                                               |
| `failed`   | `origin?`, `at`, `description?`, `step?`                           | a failure stops or degrades the runner: `origin` the operator, effect or clock it failed at (a journal failure journals nothing, §9.2); `step` the step it rolled back, if one was                                                                                                                                                    |
| `recovery` | `origin`, `at`                                                     | the graph degrades (§11); from here on only the recovery scope's steps follow                                                                                                                                                                                                                                                         |

A failure is journaled as cause then consequence: the `failed` entry, then `recovery` when the
graph degrades, then the re-run step; a member failing during the re-run, or a recovery callback
throwing, adds its own `failed` entry ("is journaled, cause then consequence" for each of "a step
that throws in a graph without a recovery scope", "a step that throws inside the recovery scope",
"a step that throws outside the recovery scope", "a member that throws during the re-run", "a
recovery callback that throws", "an effect that
rejects"). A refused route's step lands, and is journaled, before its `failed` entry
(untested).

`description` is `describe(error)` when the option is given, computed as the entry is written, after
the runner has stopped or degraded, so describing cannot change the stop; a `describe` that throws
leaves it out, and without the option no error text is journaled ("leaves error text out unless
the journal describes it, and replay counts only steps", "describes a failure only once the runner
has degraded, so describing cannot change the stop").

### 9.2 Capacity and failure

- **The journal never holds a step.** An append is never awaited by a step or an effect ("bounds the
  journal queue in encoded bytes, queued plus in flight").
- **Capacity.** `capacityBytes` bounds the canonical encoded bytes queued plus in flight. An entry
  that would exceed it closes the journal with `JournalOverflowError`; the step itself never waits
  ("bounds the journal queue in encoded bytes, queued plus in flight").
- **Failure arbitration.** The first failure owns graph recovery and the runner outcome. If writing
  that failure overflows or fails the journal, the journal error is attached as the secondary
  finalization failure and recovery still runs exactly once ("preserves the first failure and runs
  recovery once when failure journaling overflows").
- **A failed append**, rejected or thrown, closes the journal with `JournalFailedError` carrying the
  sink's error as its cause ("fails the graph on a failed append, keeping the sink error as its
  cause", "treats a sink that throws instead of rejecting as a failed append").
- **I/O deadline.** Each append and finalization has a finite deadline, defaulting to
  `DEFAULT_JOURNAL_IO_TIMEOUT_MS` and overridable with `ioTimeoutMs`. Expiry fails the journal with
  `JournalFailedError` caused by `JournalIoTimeoutError`; graph steps and recovery never await the
  journal. A timed-out append aborts its signal, discards the remaining queue, and prevents a later
  journal operation from overlapping it ("reaches a terminal clean-stop outcome when an append
  never settles", "does not overlap finalization with a timed-out append during direct abandon",
  "reaches a terminal abandon outcome when finalization never settles", "runs recovery without
  waiting for a never-settling journal append").
- **A closed journal fails the graph from `journal`**, as a failed operator outside every recovery
  scope would (§11): the recovery scope winds down and nothing outside it runs after, and in a
  graph without one the runner stops; no request the overflowing step delivered to an effect
  outside the recovery scope starts, while a recovery effect still takes that step's requests
  ("winds the recovery scope down on an overflow, and runs nothing outside it after", "winds the recovery scope
  down on a failed append, and runs nothing outside it after", "starts nothing the step that
  overflowed it delivered, though an effect was running"). No later entry is accepted, including
  the `failed` and `recovery` entries for this failure. Any rejected append leaves the sink's
  contents unknown, so every queued entry is discarded ("discards every queued append after a failed
  append"); so is every entry queued behind one that grew past capacity while being written, so a
  failed file never has a gap ("reports write-time growth overflow as failed, writing nothing queued
  behind it, for"). After any journal failure, including overflow, the sink finalizes without a
  clean end record ("bounds the journal queue in encoded bytes, queued plus in flight", "reports
  write-time growth overflow as failed, writing nothing queued behind it, for"); after a deadline the sink is not finalized, so no
  later journal I/O can overlap the timed-out operation.

### 9.3 Lifecycle and file container

`stopped` and `abandon()` do not settle until effects have settled, no more append is possible, and
all accepted appends have settled, been discarded after failure, or reached their deadline. The sink
has then finalized or reached its deadline. An append rejection arriving after stop is still the
runner's outcome ("waits for a late append rejection after stop and surfaces it"). One shutdown owns
effect settlement and finalization, so a finishing-effect failure plus a finalization failure
produces one handled `RunnerFinalizationError` ("owns finalization once when finishing work and
finalization both fail").
When graph work and journal finalization both fail, `RunnerFinalizationError` carries the graph
failure as `runnerError` and the journal failure as `journalError` ("keeps the graph error when
finalization also fails").

`@repo/kit` supplies one exclusive file per process run. Every directory it creates is mode `0700`,
pre-existing directories are unchanged, its file is mode `0600`, and its header carries the
container format, engine journal format, graph id, run id,
start time and a runtime-validated build identity containing only a short `revision` and `imageTag`;
URL-shaped values, credential-shaped values and extra fields are refused before file creation
(review). Directory creation and permissions, exclusive file open, header write and `fdatasync`,
and directory sync share the runner's finite journal I/O deadline. Expiry rejects startup with
`JournalIoTimeoutError` and starts closing each handle already acquired, without waiting for the close
to finish (review). Each canonical JSONL entry
is acknowledged only after `fdatasync`; clean finalization writes an end record, syncs the file,
closes it, then syncs the containing directory. Finalization after any runner journal failure closes
the file and syncs the directory without writing a clean end record (review).

The file reader decodes and validates its header, frames and ordering one line at a time. It returns
a truncated final frame as a reported crash tail, but reports a malformed newline-terminated frame
or a semantically invalid delta chain as corruption. A bad UTF-8 line retains the validated header
and entry prefix (review). Startup leaves old run files untouched; the reader validates an old run
only when a person or agent asks to read it (review).
Invalid capacity is refused before a file is created (review). The opener returns a deadline-bound
`finalize` for the startup caller to close a sink when runner construction throws (review).

## 10. Replay

`replay(graph, entries)`, from `@repo/engine/replay` and for tests and tools only, reconstructs keyed
deltas from earlier complete writes in the same run, then re-runs each `step` entry's writes and
wakes, under the recorded stamp, on a fresh copy of the graph, and
compares the derived writes it produces, node by node and digest by digest, with the entry's. It
runs no effect: effect results are among the journaled writes, and every request an effect would
have taken is discarded. Notes and `failed` entries are skipped. A `recovery` entry switches it to
evaluating only the recovery scope's members, as the run did. It reports `{ ok: true, steps }`,
counting steps only, or the first step that differs: `{ ok: false, step, reason }`, with `reason`
`derived writes differ` or `the step threw: <message>` ("replays a journal's stamped steps without
running an effect, and finds a step that differs", "journals the recovery, so its steps replay as
they ran", "journals the wake as a step of its own, which replay reproduces").

Replay compares derived writes, not effects, notes or the values of external writes, and it is only
as faithful as the graph it is given: the same declaration, with the same operators, must be
rebuilt from the code and configuration that ran (review).

## 11. Failure, recovery and stopping

Where this section says the runner journals something, it does so only while a journal is configured
and open (§9) (untested).

A **failure** is a step that throws (any operator, a refused derived write, a cycle past its
bound), an effect's handler that throws or rejects, a refused request (§7.1), a lane policy that
re-enters the runner (§7.4), a clock whose `value` throws or is not data ("stops the graph with its
failure"), or a closed journal (§9.2). Its **origin** is the operator, effect, clock or `journal` it
happened at.

- **Without a recovery scope**, or when the origin is inside the one there is, or, once the graph
  is degraded, when the origin is a member or unnamed, the runner **halts**: it journals the
  failure, aborts every effect, drops every
  waiting request, clears every clock, and `stopped` rejects with the error once every running
  effect has settled ("stops at once when the recovery itself fails").
- **A failure outside the recovery scope degrades the graph.** The runner journals the failure and
  a `recovery` entry; from then on only the scope's members are evaluated, started or ticked: other
  operators keep their last value, other effects running are aborted, their waiting requests
  dropped and their clocks cleared, and a later failure of a non-member is ignored. The step it
  rolled back, if one was, is re-run with the rest of the graph left out, so each member folds from
  the state that step left; then `onFailure(error, origin, read)` of the scope gives the writes
  that wind it down, which are pushed as a step before any effect starts. A member that throws
  during the re-run, or an `onFailure` that throws, halts the runner with that error ("keeps only
  its recovery running after an operator outside it fails, until it winds down", "winds its
  recovery down after an effect outside it rejects", and "is journaled, cause then consequence" for
  each of "a member that throws during the re-run", "a recovery callback that throws").
- **A degraded graph ends in `GraphFailedError`**, carrying the origin, the cause, and the value the
  scope stopped the runner with through `context.stop`; when `onFailure` returned nothing to wind
  down, the runner stops as soon as the re-run step lands and `stop` is `undefined` ("stops once
  the step it rolled back lands, when the recovery has nothing to wind down").
- **A clean stop** is `context.stop(value)` from an active effect: every effect's signal aborts, no
  step propagates after it, effects that finish on stop run their queue (§7.5), and `stopped`
  resolves with `value` once every running effect has settled and the journal has finalized, so work that must land does
  ("resolves its stop with the value an effect stops it with, after work that must land", "settles
  the stop only after the work that stopped it, though that work goes on after"). After a degrade it
  rejects with `GraphFailedError` instead; after a finishing effect started by the stop failed,
  with that error (§15).
- **`runner.abandon()`** aborts every effect, clears every clock and timer ("writes its node on its
  period once started, and never after the runner stops"), drops every waiting request, and
  resolves once each running effect has settled and the journal has finalized; nothing propagates
  after it and `stopped` stays pending ("waits for a late append rejection after stop and surfaces
  it").
- **Clocks** start on `runner.start()`, which also arms the expiry timer; a clock's write is a step
  like a push, and a clock inside the recovery scope keeps ticking after a degrade ("writes its node
  on its period once started, and never after the runner stops", "keeps only its recovery running
  after an operator outside it fails, until it winds down").

The engine does not know that the kernel is a bot's recovery scope; that is how `@repo/kernel`
declares itself, and `framework/kernel/SPEC.md` §13.1 says what it does with the wind-down (review).

## 12. Reachability

`reachable(graph, from, { skipRecovery? })`, for tools that check a graph's shape before it runs,
maps every node a write to one of `from` may lead the runner to write, over declared edges, emits
and results, to the node it was reached through, with each of `from` mapped to itself. An operator
is reached through every edge that can schedule it: everything but a `sample` of a node with an
initial value. An effect is reached through its `every` requests and, when it declares `ready`,
through its samples too, since a waiting request's `ready` is re-checked against every sample.
Clocks and expiries are not seeded. With `skipRecovery`, the recovery scope's operators and effects
carry nothing further ("maps each node a write can lead to onto the node it was reached through",
"stops at a sample of a node with an initial value, and passes one of a node without", "reaches a
node read along two paths through the first of its reads already reached", "starts an effect from
its every requests, and from its samples only when it waits on ready", "carries nothing through the
recovery scope when asked to skip it").

## 13. Package boundary

`@repo/engine` has no runtime or peer dependencies and imports nothing but its own modules and Node
built-ins, so it cannot know about chains or the kernel ("has no runtime dependencies, so it cannot
know about chains or the kernel", "imports nothing but its own modules and node built-ins", which
reads `from` imports). Its
exports are the package root, `@repo/engine/replay` and `@repo/engine/testing`.

## 14. What is deliberately left out

- **A bound on a blocked map's `every` buffers** (§3). They grow until the map runs.
- **A second recovery scope.** One scope, one wind-down, one stop; a composite stop does not exist.
- **Journal retention and rotation.** The file container is built, but automatic rotation,
  checkpointing and retention are not. A process start creates a new run; operators rotate by
  restarting and retain or delete whole finalized runs (review).
- **Memoized evaluation and graphs whose shape depends on data**, as the dataflow ADR left them.
- **Dropped work.** No lane, queue or journal drops work silently: each refuses and stops.

## 15. Residual risks

- **A journal failure leaves no marker.** Nothing is journaled after the journal closes, so a
  journal that ends mid-run reads the same whether the sink failed or the process died.
- **A second failure after a degrade is dropped.** A non-member that throws or rejects once the
  graph is degraded is ignored and not journaled.
- **The re-run step is re-stamped.** A rolled-back step is re-run under a new `seq` and `at`, with
  its `wakes` recomputed at that time rather than copied, so its journaled re-run is not
  byte-identical to the failed step.
- **Buffers are unbounded** (§3, §14), so a map blocked for long holds memory for every delivery.
- **`ready` is re-evaluated for waiting requests whenever their lane has a free slot**, so a lane
  with many waiting requests and a costly `ready` can pay that on every step.
- **A `write` from an effect with no `results` node** is a declaration error found only when the
  handler first writes, as a `GraphDefinitionError` thrown into the handler.
- **The runner's `now()` is not checked.** A `now` option that returns a non-finite number stamps
  steps with a value `encode` would refuse; a clock's non-finite value, by contrast, fails the
  graph.
- **An effect's identities are forgotten once handled.** Only a waiting or running duplicate is
  refused, so a request redelivered after its first completed runs again unless its `sequence`
  refuses it.
- **A `KeyedWrite`'s `coverage` is checked by the types only**: a value outside the four kinds is
  stored as a status.
- **`encode` sees only enumerable string-keyed fields and detects no cycle.** Symbol-keyed and
  non-enumerable fields are neither checked nor frozen, so a reader can change them, and a cyclic
  object throws a `RangeError` rather than `NotDataError`.
- **A level write whose `value` is `undefined` is queued.** `encode` drops the field, so the push
  does not throw; the step then fails the graph when the value is digested.
- **A `sequence` position is not validated.** `NaN` passes the comparison, and once admitted, every
  later position passes too.
- **An operator may reuse an earlier effect's id.** A `failed` entry's `origin` is then ambiguous,
  and a failure of a non-member operator named like a member effect halts instead of degrading.
- **The builder is not consumed by `build()`.** The graph shares the builder's collections, so a
  declaration after `build()` changes the built graph; treat the builder as consumed.
- **A finishing effect's failure is caught only for requests the stop started.** A `finishOnStop`
  request already running when the clean stop begins rejects into a finished runner, which ignores
  it, so `stopped` can resolve though that request failed.

## 16. Traces

The scenario tests live in [`test/`](./test), one vitest file per module: the graph declaration
(`graph.test.ts`), the runner, effects, lanes, expiries, the journal and recovery
(`runner.test.ts`), keyed levels and maps (`keyed.test.ts`), replay (`replay.test.ts`),
reachability (`reach.test.ts`), data (`data.test.ts`) and the package boundary (`package.test.ts`).
A trace this spec names by quotation is the title, or the start of the title, of a test or
`describe` block in one of them; an `it.each` title is quoted by its start, with its cases named
where they carry the claim.
