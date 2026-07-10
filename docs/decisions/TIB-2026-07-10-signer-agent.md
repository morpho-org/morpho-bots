# TIB-2026-07-10: Signing agent — keyless queue behind a policy-enforcing socket daemon

| Field      | Value                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| **Status** | Accepted                                                                                  |
| **Date**   | 2026-07-10                                                                                |
| **Author** | @hayden                                                                                   |
| **Scope**  | Repo-wide (`packages/signer`, `@repo/bot-kit`, both bot cores, `interfaces/cli`)          |
| **Amends** | [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) — key-custody clause only |

---

## Context

[TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) made `queue` the sole holder of the
signer private key: `loadQueueConfig` requires `LIQUIDATOR_PRIVATE_KEY` and `createSigner` does
`privateKeyToAccount` in-process. That concentrates custody in a process that also parses untrusted
stdin, dials RPCs, and runs venue-adjacent code — a compromise of the queue host is total key loss.
User decision: the queue stops being responsible for signing. The seam already exists —
`createPendingQueue` consumes only the four `Signer` function primitives and never sees the key —
so extracting signing is a repackaging of an existing boundary, not new machinery. This TIB and its
implementation land in the same PR, so it is **Accepted** on arrival.

## Goals / Non-Goals

**Goals**

- **One key holder.** A tiny in-house signing agent (`@repo/signer`, run as `morpho-bots signer`)
  is the only process that ever reads the private key.
- **Default-deny policy before every signature.** The agent refuses to start without a valid,
  non-empty policy file and signs iff at least one rule passes all its checks.
- **A netcat-testable wire.** A versioned JSON-lines protocol over a Unix domain socket
  (`node:net`), debuggable with `echo … | nc -U`.
- **Signatures-only agent.** Nonce cursor, RBF, gas estimation, and broadcast all stay client-side;
  the agent holds no RPC.
- **Zero dev breakage.** The in-process local-key path stays the default; the agent is opt-in via
  `SIGNER_SOCKET`.
- **An extensible policy seam.** A calldata-module registry lets future bots (e.g. an Allocator
  reallocation bot) plug in their own semantic checks without touching the agent core.

**Non-Goals**

- **Semantic calldata inspection in v1.** The `CALLDATA_MODULES` registry ships **empty** (user
  decision); the deferred module designs are recorded below.
- **An agent-side RPC or simulation.** v1 policy is purely structural.
- **Prod wiring.** The sidecar + shared-socket-volume deployment is deferred with the shelved
  Railway migration; compose files keep the local-key default.
- **Key rotation / HSM custody.** Out of scope; the agent narrows _where_ the raw key lives, not
  _what form_ it takes.

## Current Solution

`queue` reads `LIQUIDATOR_PRIVATE_KEY` from the merged env, `assertLiquidatorAddressMatchesKey`
cross-checks it against `LIQUIDATOR_ADDRESS`, and `createSigner({privateKey})` calls
`privateKeyToAccount` in-process (`interfaces/cli/src/commands/queue.ts`). Every host or
supply-chain compromise of the queue process is a key compromise. There is no policy layer between
"the queue decided to broadcast" and "the key signed."

## Proposed Solution

### The agent

`@repo/signer` (new `packages/signer`) provides a long-lived **foreground daemon** started as
`morpho-bots signer`: it loads `SIGNER_PRIVATE_KEY`, loads and validates the policy file, listens
on a Unix domain socket (`--socket` > `SIGNER_SOCKET` > `<home>/signer.sock`), and answers
requests until SIGTERM/SIGINT. Server and client both use **`node:net`** — one API for both
halves, mature Unix-socket path/close semantics, and no Bun-isms in the package (fully supported
under Bun). The `to` allowlist is explicit operator config, so the package takes **no
`@repo/contracts` dep** — the trust boundary stays visible in the policy file.

### Wire protocol (versioned JSON-lines, one request line in, one response line out)

`SIGNER_PROTOCOL_VERSION = 1`. Requests
`{v, id, method: 'ping' | 'address' | 'signTransaction', params?}`; responses `{v, id, result}` or
`{v, id, error: {code, message, rule?, check?}}` with codes
`bad_request | unsupported_version | policy_violation | internal`.
`WireTx = {type:'eip1559', chainId, to, data, value, nonce, gas, maxFeePerGas, maxPriorityFeePerGas}`
— `to` is required (the agent refuses contract deployments), and **bigints are bare decimal
strings**, matching the `records.ts` wire convention. **All eight fields are required and
`gas > 0`** — viem silently signs gas-less transactions, so the agent hard-requires what viem
tolerates. Oversize lines (> 64 KiB) get `bad_request` + disconnect; any internal throw becomes an
`internal` response, never a crash. Connections stay open; concurrent connections are safe (pure
CPU, no shared state).

### Default-deny policy

The policy file (`SIGNER_POLICY_PATH`, default `<home>/signer-policy.json`) is a list of rules;
a request is signed iff **at least one rule passes all its checks** (file order, first match wins).
Missing, invalid, or empty-rules file → the daemon refuses to start (exit 2).

```jsonc
{
  "version": 1,
  "rules": [{
    "name": "blue-liquidation-base",
    "chainIds": [8453],
    "to": ["0x…executor…"],
    "selectors": ["0x00000001"],        // optional
    "maxValueWei": "0",                 // default "0"
    "maxFeePerGasWei": "300000000000",  // required
    "maxGasLimit": "15000000",          // required
    "maxDataBytes": 200000,             // optional
    "calldata": { "module": "…", "config": {} }  // optional; v1 registry is EMPTY
  }]
}
```

**Threat model.** The load-bearing checks are **`to == Executor`** and **`value == 0`**:

- The liquidator EOA holds **zero ERC20 approvals anywhere**, so accumulated profits sitting on
  the EOA can only move via a transaction _to the token contract itself_ — which `to == Executor`
  forbids. This is what makes the check principal-protecting.
- ETH sent along with an Executor call is **instantly stealable in-batch** via the generic
  Executor's arbitrary multicall, so `value == 0` closes that path.

Everything else bounds gas-griefing: the `chainIds` allowlist, the fee and gas ceilings, and the
optional `maxDataBytes` (Base's L1 data fee makes calldata size a cost vector). Ceilings are
**per-rule, so per-chain semantics are one rule per chain** — Robinhood's ArbOS folds the L1
poster fee into the gas limit, so its gas numbers are not Base's gas numbers.

**Stateless per-request.** Every check evaluates one request in isolation — no nonce state in the
agent — so the pending-queue's same-nonce RBF re-signs (`replaceStuck`, +12.5% fee bumps) pass for
free. Interplay to respect: the agent's `maxFeePerGasWei` must be **≥ the queue's
`MAX_FEE_GWEI`**, or fee bumps degrade to mid-flight rejections — safe (nothing signs) but
degraded (stuck txs stop getting replaced).

### The keyless queue client

When `SIGNER_SOCKET` is set, the queue resolves an **agent backend**: `createAgentAccount` fetches
the agent's address (the startup handshake) and wraps `signTransaction` requests in a viem
`toAccount(...)` custom account — `signMessage`/`signTypedData` are throwing stubs. That
`LocalAccount` drops into bot-kit's `createSigner`, whose options become
`{...} & ({privateKey} | {account})`; everything else — nonce cursor, rollback,
`prepareTransactionRequest`, `sendTransaction`, RBF — is reused verbatim. bot-kit gains **no** dep
on `@repo/signer`; the CLI composes them. When `SIGNER_SOCKET` is unset, the local-key path runs
exactly as today (dev default, byte-for-byte).

Error classification at the queue:

- **Handshake mismatch** (`address` ≠ `LIQUIDATOR_ADDRESS`) → `ConfigError` → **exit 2**.
  `LIQUIDATOR_ADDRESS` stops being a key cross-check and becomes the agent cross-check.
- **Agent down / dead socket** → plain error → **exit 1** (transient; the loop retries and the
  failure surfaces every pass).
- **Policy rejection** → typed `AgentPolicyError {code, rule, check}`, distinguishable from
  execution reverts so the pending-queue's `isExecutionRevert` never misclassifies a policy denial
  as an on-chain revert.

The client whitelist-extracts exactly the signing fields into `WireTx` — it never forwards viem's
prepared blob — and uses one short-lived connection per request (correct across daemon restarts,
no reconnect logic; Unix-socket latency is negligible at queue cadence).

### Key custody and socket hygiene

- The agent reads **`SIGNER_PRIVATE_KEY`** (signer section of `secrets.json`), with **no fallback
  to `LIQUIDATOR_PRIVATE_KEY`** — a silent fallback would leave the key living in both places,
  defeating the point; the error message says to move it.
- The private key is read by **exactly one process**: the agent when `SIGNER_SOCKET` is set, else
  the queue (local backend). No other stage or package may read it.
- The daemon **never logs the key or full signed-raw-tx blobs** (tx fields/hash only); the key
  goes straight from the merged env into `privateKeyToAccount` and never lands on a logged object.
- Socket permissions without a race window: `process.umask(0o177)` around the listen call, so the
  socket is **born 0600**, plus a `chmodSync` belt-and-braces after. `sun_path` length is
  validated up front (macOS caps it at ~104 bytes) with a clear `ConfigError`. A stale socket is
  probed (connect refused → unlink; alive → "already listening", exit 2), and `close()` unlinks.

### Extensibility seam — `CALLDATA_MODULES`, empty in v1

`CalldataModule = {parseConfig, check}`; a rule's optional `calldata: {module, config}` names a
registered module, an unknown name is a startup error, and **the registry ships empty in v1**
(user decision — tests register a toy module). Two designs were evaluated and deferred:

- **Skim-recipient decode** — parse Executor calldata and lint that skim recipients are the EOA.
  Feasible but **lint-grade only**: the swap sub-call is opaque venue calldata the agent cannot
  see through, and midnight's bad-debt branch has no skims and a different recipient position.
  It also couples the agent to the cores' encode paths, which drift.
- **Agent-side balance-delta simulation** — the real anti-diversion control (simulate the tx and
  assert the EOA/Executor balance deltas), immune to encode drift — but it requires the agent to
  hold its own RPC, which v1 deliberately does not.

A future Allocator reallocation bot plugs its checks in at this seam.

### Implementation Phases

- **PR1 — `feat(signer): add signing agent package and account-based signer`:** `@repo/signer`
  (protocol, policy, server, client + tests), the bot-kit `createSigner({account})` option, this
  TIB.
- **PR2 — `feat(cli): add keyless queue via signer agent socket`:** `SignerBackend` resolution in
  both cores, the queue's agent path + exit-code classification, the `signer` command (reserved
  op name), `init` scaffolding (`signer-policy.json`, secrets placeholder), docs
  (CONVENTIONS.md key-custody rule, CLAUDE.md, `bots/README.md`).

## Amended Decisions

This TIB amends exactly one clause of
[TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md); everything else stands.

1. **"`queue` is the sole holder of the signer private key"** becomes: the private key is read by
   exactly one process — the **signing agent** when `SIGNER_SOCKET` selects the agent backend,
   else the `queue` command (local-key default). The single-key-holder _principle_ is preserved
   and strengthened; only _which_ process holds it changes. `sense`/transform stages remain
   key-free as before.

## Considered Alternatives

### Alternative 1: Off-the-shelf remote signer (Web3Signer, cloud KMS)

**Why rejected:** User decision in favor of a tiny in-house agent. The value is the
**Morpho-specific policy** (`to == Executor`, `value == 0`, per-chain ceilings, the calldata-module
seam) — generic signers make that policy an external configuration language at best, and bring a
much larger operational and dependency surface for a bot that needs one EOA and one check-list.

### Alternative 2: Signing as a pipe stage

Make signing another transform in the `<op> | <op> | queue` pipeline.

**Why rejected:** Impossible, not just inelegant — a signature binds the **nonce and fees**, which
are decided at broadcast/RBF time inside the queue (the cursor, `initialFees`, +12.5% bumps). A
pipeline stage runs before those exist. The signer is a **callable capability**, like `ssh-agent`,
not a stream transform.

### Alternative 3: Keep the key in the queue (status quo)

**Why rejected:** Total key loss if the queue host is compromised — the queue parses untrusted
stdin, dials RPCs, and carries venue keys; concentrating the signing key there gives one process
compromise everything. The agent bounds that blast radius to policy-conforming signatures.

### Alternative 4: `Bun.listen` for the socket server

**Why rejected:** `node:net` gives one API for both server and client halves, mature Unix-socket
path/close semantics, and keeps `@repo/signer` free of Bun-isms — while remaining fully supported
under Bun.

## Assumptions & Constraints

- **The liquidator EOA never grants ERC20 approvals — an operational invariant, enforced by
  humans.** The zero-approvals fact is what makes `to == Executor` principal-protecting; a single
  manual approval from the EOA silently voids the threat model.
- **Agent fee ceiling ≥ queue `MAX_FEE_GWEI`.** Otherwise RBF bumps degrade to policy rejections —
  safe but degraded (documented; a queue-side startup `ping` echoing ceilings is a future nicety).
- **One daemon serves all chains.** The CLI `signer` config section is chain-less; per-chain policy
  lives in the policy file (one rule per chain).
- **`MORPHO_BOTS_HOME` should be 0700.** The socket itself is 0600; directory hygiene is the
  operator's half of the contract.
- **Gas estimation and broadcast stay client-side.** The agent has no RPC in v1; anything needing
  chain state (including the balance-delta module) forces that assumption to be revisited.

## Security

- **Residual risk, stated explicitly:** with structural-only v1 checks, a compromised client host
  can still get **arbitrary Executor multicalls** signed — bounded by chain, `to`, `value`, fee,
  and gas ceilings, but not by calldata semantics. The empty `CALLDATA_MODULES` registry is the
  seam that closes this later (lint decode or balance-delta simulation).
- **Default-deny everywhere:** no policy file → no daemon; no matching rule → no signature;
  missing tx field or `gas == 0` → `bad_request`; contract deployment (`to` absent) → refused.
- **The key never leaves the agent process** and never appears in logs or error payloads; policy
  rejections carry rule/check names, not transaction reproductions.
- **Socket is born 0600** (umask around listen — no chmod race window).

## Observability

- `signer.listening {socket, address, rules}` on startup and `signer.rejected {rule, check}` per
  denial, both to stderr (stdout stays silent — the daemon is not a pipeline stage).
- Policy rejections surface on the queue side as typed `AgentPolicyError`s in stderr logs,
  distinguishable from execution reverts and from transient socket failures (exit 1) and config
  mismatches (exit 2) — the 0/1/2 contract is unchanged.

## Future Considerations

- **Calldata modules** — the two deferred designs above; the balance-delta module is the real
  anti-diversion control and the trigger for giving the agent an RPC.
- **Allocator reallocation bot** — the first planned non-liquidation consumer of the policy seam.
- **Prod sidecar wiring** — agent container + shared socket volume, deferred with the shelved
  Railway migration.
- **Ceiling handshake** — a queue-side startup `ping` that echoes the agent's fee ceilings would
  turn the fee-interplay footgun into a startup warning.

## References

- [TIB-2026-07-09: UNIX-pipeable CLI](./TIB-2026-07-09-pipeline-cli.md) — the queue this TIB makes
  keyless; its key-custody clause is amended here, everything else stands.
- [TIB-2026-07-10: Commands are op names](./TIB-2026-07-10-op-commands.md) — the flat op namespace
  in which `signer` becomes a reserved name.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — `createSigner` / `createPendingQueue`, whose account seam this TIB opens.
- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md),
  [TIB-2026-06-30: Blue liquidation bot — v0](./TIB-2026-06-30-blue-liquidation-bot.md) — the
  generic Executor whose arbitrary-multicall shape drives the `value == 0` and `to == Executor`
  checks.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
