import { getRepo, getSha, info, setFailed, setOutput, warning } from '../../lib/actions'
import { githubApi, paginate } from '../../lib/github'
import { bodyIntentTimes, EDIT_HISTORY_RETENTION, type PullRequest } from '../common'
import { computeHumanApprovals, evaluateReleaseGate, type ReviewLike } from '../gate'
import { findMergedPullRequest, parseReleaseIntents } from '../helpers'
import { botIds, deployTargets, loadManifest } from '../manifest'

/**
 * Turns the `Releases <bot>` intent of the squash commit just pushed to main into the set of bots
 * authorized to deploy to production, as a `deploy-bot.yml` matrix (`targets`), the bare id list
 * (`bots`), and the PR number (`pr`, the release tag suffix).
 *
 * Two checks make an unreviewed edit unable to ship: the commit must bind to a merged PR whose
 * `merge_commit_sha` IS this commit (the subject's `(#N)` is never trusted), and each bot must pass
 * the release gate at the `merged_at` snapshot. Refused bots are reported on the PR and deploy
 * nothing. No intent means an empty matrix, and every downstream job skips.
 */
async function main(): Promise<void> {
  const { owner, repo } = getRepo()
  const sha = getSha()
  const manifest = loadManifest()
  const knownBots = botIds(manifest)

  const commit = await githubApi<{ commit: { message: string } }>(
    'GET',
    `/repos/${owner}/${repo}/commits/${sha}`
  )
  const intents = parseReleaseIntents(commit.commit.message, knownBots)
  emit([], [], null)
  if (intents.length === 0) {
    info('No release intent on HEAD — nothing to deploy')
    return
  }

  const prs = await githubApi<PullRequest[]>('GET', `/repos/${owner}/${repo}/commits/${sha}/pulls`)
  const pr = findMergedPullRequest(prs, sha)
  if (!pr?.merged_at) {
    throw new Error(`No merged PR has ${sha} as its merge commit — refusing to release`)
  }

  const reviews = await paginate<ReviewLike>(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews`)
  const approvals = computeHumanApprovals(reviews, pr.user.login, pr.merged_at)
  const history = await bodyIntentTimes({ owner, repo }, pr.number, knownBots, pr.merged_at)
  const { authorized, refused } = history.truncated
    ? {
        authorized: [],
        refused: new Map(
          intents.map(bot => [
            bot,
            `the PR body has ${EDIT_HISTORY_RETENTION}+ edits, so GitHub no longer holds the full history needed to date the intent`
          ])
        )
      }
    : evaluateReleaseGate({ intentBots: intents, intentTimes: history.times, approvals })

  for (const [bot, reason] of refused) warning(`Refusing to release ${bot}: ${reason}`)
  if (refused.size > 0) {
    await githubApi('POST', `/repos/${owner}/${repo}/issues/${pr.number}/comments`, {
      body:
        `⚠️ **Release refused** for: ${[...refused.entries()]
          .map(([bot, reason]) => `\`${bot}\` (${reason})`)
          .join(', ')}.\n\n` +
        'A bot deploys only when a reviewer other than the author approved this PR after its ' +
        '`Releases <bot>` intent was added. To release, open a new PR carrying the intent and get ' +
        'it approved after the intent is in the description.'
    })
  }

  info(`PR #${pr.number} authorized: ${authorized.join(', ') || 'none'}`)
  emit(deployTargets(manifest, 'production', authorized), authorized, pr.number)
}

function emit(targets: unknown[], bots: string[], pr: number | null): void {
  setOutput('targets', JSON.stringify(targets))
  setOutput('bots', JSON.stringify(bots))
  setOutput('pr', pr === null ? '' : String(pr))
}

main().catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
