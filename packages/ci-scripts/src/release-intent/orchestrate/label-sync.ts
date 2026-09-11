import { getRepo, info, readPayload, setFailed, warning } from '../../lib/actions'
import { githubApi } from '../../lib/github'
import { type PullRequest } from '../common'
import { parseReleaseIntents, RELEASE_LABEL_PREFIX } from '../helpers'
import { botIds, loadManifest } from '../manifest'

/**
 * Projects a PR description's `Releases <bot>` intent onto `release-<bot>` labels. The description
 * is the single source of truth; labels are a bot-owned visual cue only, so a hand-added release
 * label is removed on the next sync and nothing in the deploy path reads them.
 */
async function main(): Promise<void> {
  const { owner, repo } = getRepo()
  const payload = readPayload<{ pull_request?: { number: number } }>()
  if (!payload.pull_request) {
    info('No pull_request in payload — skipping')
    return
  }
  const prNumber = payload.pull_request.number

  const pr = await githubApi<PullRequest>('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`)
  if (pr.base.ref !== 'main') {
    info(`PR #${prNumber} targets ${pr.base.ref}, not main — skipping`)
    return
  }

  const intents = parseReleaseIntents(pr.body, botIds(loadManifest()))
  const desired = new Set(intents.map(bot => `${RELEASE_LABEL_PREFIX}${bot}`))
  const current = new Set(
    pr.labels.map(l => l.name).filter(name => name.startsWith(RELEASE_LABEL_PREFIX))
  )
  const toAdd = [...desired].filter(l => !current.has(l))
  const toRemove = [...current].filter(l => !desired.has(l))

  if (toAdd.length === 0 && toRemove.length === 0) {
    info(`PR #${prNumber} release labels already in sync (${[...desired].join(', ') || 'none'})`)
    return
  }

  try {
    for (const label of toRemove) {
      await githubApi(
        'DELETE',
        `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`
      )
    }
    if (toAdd.length > 0) {
      await githubApi('POST', `/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
        labels: toAdd
      })
    }
  } catch (error) {
    warning(
      `Could not update release labels: ${(error as Error).message}. Labels are cosmetic; ` +
        'check the job has `pull-requests: write`.'
    )
    return
  }
  info(`PR #${prNumber} release labels: +[${toAdd.join(', ')}] -[${toRemove.join(', ')}]`)
}

main().catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
