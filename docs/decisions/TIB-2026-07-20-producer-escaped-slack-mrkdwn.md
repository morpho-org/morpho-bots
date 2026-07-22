# TIB-2026-07-20: producer-escaped Slack mrkdwn in monitor-bot alerts

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-20       |
| **Author** | @jinmel          |
| **Scope**  | App: monitor-bot |

---

## Context

monitor-bot alerts move to a one-line format with explorer links:
`($size $symbol $action)[tx link] by ($address)[address link] on midnight-base at $time`. Slack
links are mrkdwn `<url|label>` constructs, and Slack treats `&`, `<`, `>` as control sequences
(`<!channel>` mentions, links) — so every API-sourced string in an alert must be escaped somewhere.
The original `Alert` contract escaped everything in the dispatcher at dispatch time, which is safe
but incompatible with links: escaping a built `<url|label>` destroys it.

## Goals / Non-Goals

**Goals**

- One-line alerts whose tx-hash and address segments link to the block explorer.
- Keep Slack injection impossible: no API-sourced string can produce a mention or an unintended
  link, same guarantee as before the change.
- Keep the dispatcher dumb. It renders one string per alert and knows nothing about alert shapes.

**Non-Goals**

- Type-level enforcement that `text` is escaped (e.g. a branded escaped-string type). The boundary
  is helpers plus review — see Assumptions & Constraints.
- Rich Block Kit layouts (fields, buttons, multiple blocks per alert). An alert stays one mrkdwn
  string.

## Current Solution

`Alert` was `{ key, title, lines[], severity }`. `SlackDispatcher` escaped `title` and every line
at dispatch, so producers emitted plain text and never thought about Slack at all. The single
choke point was the whole injection defence — and the reason links were impossible.

## Proposed Solution

The Slack-escaping trust boundary moves from the dispatcher to alert producers
(`bots/monitor-bot/src/alerts/alert.ts`):

```ts
type Alert = {
  key: string
  /** The alert as one plain-text sentence — Slack's notification fallback and the log line. */
  title: string
  /** The same sentence as Slack mrkdwn with explorer links; dispatchers render this VERBATIM. */
  text: string
  severity: 'info' | 'warning' | 'critical'
}
```

- **`text`** is producer-built mrkdwn. Producers escape every interpolated API-sourced string via
  the new `src/alerts/mrkdwn.ts` helpers — `escapeSlack` for free text, `slackLink(url, label)`
  for link segments — and `SlackDispatcher` renders the string verbatim.
- **`title`** is the plain-text sentence. The dispatcher escapes it for the `chat.postMessage`
  notification-fallback `text` field, and `LogAlertDispatcher` logs it.

The asymmetry — `text` trusted verbatim, `title` escaped at dispatch — is deliberate: anything
that is mrkdwn must be escaped at build time or its links die; anything that stays plain keeps the
old escape-at-dispatch treatment.

### Invariants

The recurring question this TIB exists to answer is "why doesn't the dispatcher just escape?".
Verbatim rendering is safe because of three invariants:

| #   | Invariant                               | Mechanism                                                                                                                                                                                |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Link labels are always escaped          | `slackLink` runs `escapeSlack` on its label internally; free-text segments go through `escapeSlack` directly.                                                                            |
| 2   | URL slots never receive raw API strings | `explorerTxUrl` gates on viem `isHash`, `explorerAddressUrl` on `isAddress`. A value failing validation yields `null`, and `slackLink(null, label)` degrades to the escaped plain label. |
| 3   | The notification fallback is escaped    | The `chat.postMessage` fallback `text` field is built from plain `title`, never mrkdwn — the dispatcher still escapes it (Slack parses that field as mrkdwn too).                        |

Invariant 2 was added after review: the generated API types declare `tx_hash` and `account` as
plain `string` with no format guarantee, and a `>` or `|` inside a URL slot breaks out of the
`<url|label>` construct — the one place `escapeSlack` cannot help, because URLs are not escaped.
The gates make the URL slot accept only values that structurally cannot contain mrkdwn
metacharacters.

## Considered Alternatives

### Alternative 1: keep dispatcher escaping, add structured link fields to `Alert`

Extend the contract with typed link slots (e.g. `links: { txHash?, address? }`) so the dispatcher
builds the mrkdwn itself and can keep escaping every string.

**Why rejected:** more type surface, and the dispatcher must know how to lay out every alert
shape — each new alert form grows the dispatcher instead of a producer. Producer-owned mrkdwn
keeps the dispatcher dumb and the format one string.

### Alternative 2: escape-then-unescape links at dispatch

Escape the whole string at dispatch, then recognise and restore `<url|label>` constructs.

**Why rejected:** fragile parsing. Distinguishing producer-intended links from escaped API data
inside one string is exactly the ambiguity escaping exists to remove.

## Assumptions & Constraints

- **Producer discipline is the boundary.** Nothing in the type system distinguishes escaped from
  raw strings in `text`; every new producer must route interpolated API-sourced strings through
  the `mrkdwn.ts` helpers, and review is the enforcement.
- The generated API types give `tx_hash` / `account` no format guarantee, so the `isHash` /
  `isAddress` gates in invariant 2 are load-bearing, not decoration.
- `title` must stay mrkdwn-free — the dispatcher escapes it, so any markup put there renders
  literally.

## Observability

The `alert` log event from `LogAlertDispatcher` no longer carries `lines`; `title` is the full
sentence and remains the logged surface. No new events.

## Security

This decision moves an injection defence from one choke point (the dispatcher) to a distributed
convention (every producer). The threat is unchanged — API-sourced strings smuggling `<!channel>`
mentions or arbitrary links into the curator channel — and is closed by the three invariants
above. What changes is the review obligation: a new alert producer is now security-relevant code,
and review must check that every interpolated API string in its `text` passes through
`escapeSlack` / `slackLink` and that URL slots are built only from the validated
`explorerTxUrl` / `explorerAddressUrl` helpers.

## References

- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) — the
  bot's stack and DI foundation.
- [TIB-2026-07-20-book-offer-snapshot-diffing](./TIB-2026-07-20-book-offer-snapshot-diffing.md) —
  the make-order poller, one of the producers now owning its mrkdwn.
- `bots/monitor-bot/src/alerts/mrkdwn.ts` — `escapeSlack` / `slackLink`.
- `bots/monitor-bot/src/alerts/alert.ts` — the `Alert` contract.
- `bots/monitor-bot/src/alerts/slack.dispatcher.ts` — verbatim block rendering, escaped fallback.
- `bots/monitor-bot/src/pollers/format.ts` — the one-line sentence builders and explorer URL
  gates.
- Branch `feature/monitor-bot-one-line-slack-alerts` (feat(monitor-bot): one-line slack alerts
  with explorer links).
