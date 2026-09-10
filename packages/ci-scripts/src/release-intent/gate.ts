/**
 * The release gate: a bot named by the merged PR's `Releases <bot>` intent deploys only if a
 * reviewer other than the author approved the PR *after* that intent was added, and that approval
 * was still their latest review at merge time. Intent edited in after the last approval, by the
 * author or by anyone with write access, therefore refuses the deploy instead of shipping unseen.
 *
 * Pure: callers supply reviews, intent times ({@link deriveBodyIntentTimes}) and the merge-time
 * cutoff, so the verdict is deterministic on retries and immune to post-merge edits.
 */

export interface ReviewLike {
  user: { login: string; type?: string } | null
  state?: string
  submitted_at?: string
}

interface HumanApproval {
  login: string
  submittedAt: string
}

const VERDICT_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/**
 * Latest verdict per reviewer, keeping only live approvals submitted at or before `until`, minus
 * bots and the PR author. COMMENTED reviews never replace a verdict.
 */
export function computeHumanApprovals(
  reviews: readonly ReviewLike[],
  prAuthor: string,
  until?: string
): HumanApproval[] {
  const cutoff = until === undefined ? Infinity : new Date(until).getTime()
  const latestByUser = new Map<string, ReviewLike>()
  for (const review of reviews) {
    if (!review.user || !review.state || !VERDICT_STATES.has(review.state)) continue
    if (!review.submitted_at || new Date(review.submitted_at).getTime() > cutoff) continue
    const prev = latestByUser.get(review.user.login)
    // `>=`: GitHub returns reviews chronologically, so on an equal timestamp the later element
    // wins; a strict `>` would let an earlier APPROVED outlive a same-second CHANGES_REQUESTED.
    if (
      !prev ||
      new Date(review.submitted_at).getTime() >= new Date(prev.submitted_at ?? 0).getTime()
    ) {
      latestByUser.set(review.user.login, review)
    }
  }

  const approvals: HumanApproval[] = []
  for (const [login, review] of latestByUser) {
    if (review.state !== 'APPROVED' || !review.submitted_at) continue
    if (review.user?.type === 'Bot' || login === prAuthor) continue
    approvals.push({ login, submittedAt: review.submitted_at })
  }
  return approvals
}

interface GateResult {
  authorized: string[]
  /** bot → operator-readable reason */
  refused: Map<string, string>
}

export function evaluateReleaseGate({
  intentBots,
  intentTimes,
  approvals
}: {
  intentBots: readonly string[]
  intentTimes: ReadonlyMap<string, string>
  approvals: readonly HumanApproval[]
}): GateResult {
  const authorized: string[] = []
  const refused = new Map<string, string>()
  for (const bot of intentBots) {
    const intentAt = intentTimes.get(bot)
    if (intentAt === undefined) {
      refused.set(
        bot,
        'intent is in the squash commit but not in the PR body history at merge time'
      )
      continue
    }
    const since = new Date(intentAt).getTime()
    const approver = approvals.find(a => new Date(a.submittedAt).getTime() > since)
    if (approver) authorized.push(bot)
    else
      refused.set(
        bot,
        `no approval by a non-author reviewer after the intent was added at ${intentAt}`
      )
  }
  return { authorized, refused }
}
