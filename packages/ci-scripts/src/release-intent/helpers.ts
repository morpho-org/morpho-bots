/**
 * Pure logic for release intent: a `Releases <bot>` keyword anywhere in a PR description (GitHub's
 * "Closes MKT-123" idiom) is the single source of truth for what a merge releases. The PR_BODY
 * squash setting carries the description into the squash commit on main, where the production
 * pipeline reads it. `release-<bot>` labels are derived from the body, never authored.
 *
 * A keyword match only counts when the named token is a known bot id, so ordinary prose can't
 * create intent by accident. The grammar is shared with prime-monorepo's `@repo/ci-scripts` via the
 * golden fixture `test/release-intent/__fixtures__/parse-cases.json`.
 */

export const RELEASE_LABEL_PREFIX = 'release-'

// `Releases` / `releases:` followed by one bot token, optionally continued as a comma/"and" list,
// Oxford comma included ("Releases blue-liq, midnight-liq, and quoter-bot").
const KEYWORD_RE =
  /\breleases:?[ \t]+([a-z0-9][a-z0-9-]*(?:(?:[ \t]*,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+)[a-z0-9][a-z0-9-]*)*)/gi
const LIST_SPLIT_RE = /[ \t]*,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+/i

/**
 * Bots a text (PR body or squash-commit message) declares release intent for. Tokens not in
 * `knownBots` are ignored, so typos release nothing. Case-insensitive, CRLF-tolerant, deduped,
 * sorted.
 */
export function parseReleaseIntents(
  text: string | null | undefined,
  knownBots: ReadonlySet<string>
): string[] {
  if (!text) return []
  // HTML comments are dropped first: GitHub does not render them, so intent inside one is invisible
  // to the reviewer whose approval the gate counts. Inline code/emphasis markers are then stripped
  // so `` `quoter-bot` ``-style markdown still parses; the grammar itself stays single-line.
  const normalized = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    .toLowerCase()
    .replace(/[`*_]/g, '')
  const bots = new Set<string>()
  for (const match of normalized.matchAll(KEYWORD_RE)) {
    for (const token of (match[1] ?? '').split(LIST_SPLIT_RE)) {
      if (knownBots.has(token)) bots.add(token)
    }
  }
  return [...bots].toSorted()
}

export interface BodyIntentRevision {
  editedAt: string
  body: string | null
}

interface CommitPullRequest {
  merge_commit_sha?: string | null
  merged_at?: string | null
}

/**
 * The merged PR whose merge commit produced the pushed SHA. The commits→pulls list representation
 * has no `merged` boolean; merged state is a non-null `merged_at`.
 */
export function findMergedPullRequest<T extends CommitPullRequest>(
  prs: readonly T[],
  sha: string
): T | undefined {
  return prs.find(pr => pr.merged_at != null && pr.merge_commit_sha === sha)
}

/**
 * Intent timestamps replayed from full PR body revisions: the start of the latest contiguous run in
 * which a bot's intent is present, so removing and re-adding intent resets the approval clock.
 * Revisions after `until` are ignored, which makes a merge-time snapshot deterministic under
 * post-merge edits. A recorded revision always uses its own `editedAt` (GitHub does not guarantee
 * the first node is the creation snapshot, so assuming so could backdate intent); only the
 * empty-history branch uses `createdAt`.
 */
export function deriveBodyIntentTimes({
  createdAt,
  currentBody,
  revisions,
  knownBots,
  until
}: {
  createdAt: string
  currentBody: string | null | undefined
  revisions: BodyIntentRevision[]
  knownBots: ReadonlySet<string>
  until?: string
}): Map<string, string> {
  const cutoff = until === undefined ? Infinity : new Date(until).getTime()
  const eligible = revisions
    .map((revision, index) => ({ revision, index }))
    .filter(({ revision }) => new Date(revision.editedAt).getTime() <= cutoff)
    .toSorted((a, b) => {
      const difference =
        new Date(a.revision.editedAt).getTime() - new Date(b.revision.editedAt).getTime()
      return difference || a.index - b.index
    })
    .map(({ revision }) => revision)

  if (revisions.length === 0) {
    if (new Date(createdAt).getTime() > cutoff) return new Map()
    return new Map(parseReleaseIntents(currentBody, knownBots).map(bot => [bot, createdAt]))
  }

  const starts = new Map<string, string>()
  let present = new Set<string>()
  for (const revision of eligible) {
    const bots = new Set(parseReleaseIntents(revision.body, knownBots))
    for (const bot of present) {
      if (!bots.has(bot)) starts.delete(bot)
    }
    for (const bot of bots) {
      if (!present.has(bot)) starts.set(bot, revision.editedAt)
    }
    present = bots
  }

  return new Map([...starts].filter(([bot]) => present.has(bot)))
}
