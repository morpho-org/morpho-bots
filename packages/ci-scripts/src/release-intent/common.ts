import { graphql } from '../lib/github'
import { deriveBodyIntentTimes, type BodyIntentRevision } from './helpers'

export interface PullRequest {
  number: number
  body: string | null
  labels: { name: string }[]
  base: { ref: string }
  user: { login: string }
  merge_commit_sha?: string | null
  merged_at?: string | null
}

const BODY_INTENT_QUERY = `
  query BodyIntent($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        createdAt
        body
        userContentEdits(first: 100, after: $after) {
          nodes {
            editedAt
            diff
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

interface BodyIntentPage {
  repository: {
    pullRequest: {
      createdAt: string
      body: string | null
      userContentEdits: {
        nodes: { editedAt: string; diff: string | null }[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } | null
  }
}

/**
 * Per-bot intent time replayed from the PR body's edit history (`userContentEdits.diff` is the full
 * body after each edit). See {@link deriveBodyIntentTimes} for the cutoff semantics.
 */
export async function bodyIntentTimes(
  { owner, repo }: { owner: string; repo: string },
  prNumber: number,
  knownBots: ReadonlySet<string>,
  until?: string
): Promise<Map<string, string>> {
  const revisions: BodyIntentRevision[] = []
  let after: string | null = null
  let pr: BodyIntentPage['repository']['pullRequest'] = null
  do {
    const page: BodyIntentPage = await graphql(BODY_INTENT_QUERY, { owner, repo, prNumber, after })
    pr = page.repository.pullRequest
    if (!pr) throw new Error(`PR #${prNumber} not found`)
    revisions.push(
      ...pr.userContentEdits.nodes.map(({ editedAt, diff }) => ({ editedAt, body: diff }))
    )
    after = pr.userContentEdits.pageInfo.hasNextPage ? pr.userContentEdits.pageInfo.endCursor : null
  } while (after !== null)

  return deriveBodyIntentTimes({
    createdAt: pr.createdAt,
    currentBody: pr.body,
    revisions,
    knownBots,
    until
  })
}
