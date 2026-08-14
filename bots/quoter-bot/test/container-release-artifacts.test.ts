import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')

describe('quoter-bot container release artifacts', () => {
  test('cuts labeled production releases with date-count tags and note baselines', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-production.yml'),
      'utf8'
    )
    const quoterBotRelease = workflow.slice(workflow.indexOf('  Release-quoter-bot:'))

    expect(quoterBotRelease).toContain('date="$(date -u +%Y.%m.%d)"')
    expect(quoterBotRelease).toContain('tag="${BOT}-${date}-${n}"')
    expect(quoterBotRelease).toContain('${prev:+--notes-start-tag "$prev"}')
  })

  test('dispatches the notes rewrite from both release origins', () => {
    for (const workflowPath of [
      '.github/workflows/deploy-production.yml',
      '.github/workflows/tag-releases.yml'
    ]) {
      const workflow = readFileSync(resolve(repositoryRoot, workflowPath), 'utf8')

      expect(workflow).toContain("--field event_type='write-release-notes'")
    }
  })

  test('chains the reusable publish workflow from both release origins', () => {
    const production = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-production.yml'),
      'utf8'
    )
    const tagReleases = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )

    expect(production).toContain('needs: [Select, Quoter-bot, Release-quoter-bot]')
    expect(production).toContain('uses: ./.github/workflows/publish-quoter-bot-dockerhub.yml')
    expect(tagReleases).toContain("if: needs.create-releases.outputs.release_tags != ''")
    expect(tagReleases).toContain('uses: ./.github/workflows/publish-quoter-bot-dockerhub.yml')
    // The caller must grant id-token so the called workflow can mint the OIDC token Docker
    // Hub login exchanges.
    expect(tagReleases).toContain('id-token: write')
  })

  test('documents the branch-scoped OIDC publish environment policy', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')

    expect(readme).toContain('scope its deployment branches to `main`')
    expect(readme).toContain('repo:morpho-org/morpho-bots:environment:quoter-bot-dockerhub')
    expect(readme).not.toContain('GIT_BOT_CLIENT_ID')
  })

  test('chooses release-note baselines below a backfilled release', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )

    expect(workflow).toContain('grep -Fxv -- "$tag_name"')
    expect(workflow).toContain('sort -V | grep -B1 -Fx -- "$tag_name" | head -n 1')
    expect(workflow).toContain('[ "$prev_tag" = "$tag_name" ] && prev_tag=""')
  })

  test('excludes the release being rewritten from release-note baselines', () => {
    const instructions = readFileSync(
      resolve(repositoryRoot, '.claude/commands/ci-write-release-notes.md'),
      'utf8'
    )

    expect(instructions).toContain(
      `{ git tag -l "{bot}-*" | grep -Fxv -- "$RELEASE_TAG" || true; echo "$RELEASE_TAG"; } \\`
    )
  })

  test('documents that latest only moves forward across releases', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8').replace(
      /\s+/g,
      ' '
    )

    expect(readme).toContain('`latest` only moves forward')
    expect(readme).toContain('backfilled older releases never regress it')
  })

  test('documents shared state for read-only deployment inspections', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8').replace(
      /\s+/g,
      ' '
    )

    expect(readme).toContain(
      'Read-only inspections of an existing deployment should use the same volume and variable'
    )
    expect(readme).not.toContain('Read-only commands need no state volume.')
  })

  test('keeps the complete operator configuration reference', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')

    expect(readme).not.toContain('[OUTPUT TRUNCATED')
    expect(readme).toContain('### Environment variables')
    expect(readme).toContain('### Better Stack observability')
    expect(readme).toContain('### YAML schema')
  })

  test('allows the GitHub Actions bot to rewrite release notes', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/claude-write-release-notes.yml'),
      'utf8'
    )

    expect(workflow).toContain("allowed_bots: 'github-actions[bot]'")
  })

  test('reuses immutable commit-hash images and recovers latest on reruns', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/publish-quoter-bot-dockerhub.yml'),
      'utf8'
    )

    expect(workflow).toContain('commit SHA tag already exists; reusing immutable image')
    expect(workflow).toContain("if: ${{ steps.sha-tag.outputs.exists != 'true' }}")
    expect(workflow).toContain('docker buildx imagetools create --tag "$latest" "$image"')
  })

  test('disables Husky in every workspace Docker install', () => {
    for (const dockerfilePath of [
      'bots/blue-liquidation/Dockerfile',
      'bots/quoter-bot/Dockerfile',
      'bots/midnight-crossed-books/Dockerfile',
      'bots/midnight-liquidation/Dockerfile'
    ]) {
      const dockerfile = readFileSync(resolve(repositoryRoot, dockerfilePath), 'utf8')

      expect(dockerfile).toContain('ENV HUSKY=0')
      expect(dockerfile).toContain('RUN pnpm install --frozen-lockfile')
    }
  })

  test('validates release CalVer before creating version-bump releases', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )

    expect(workflow).toContain(`CALVER_PATTERN="^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[1-9][0-9]*$"`)
    expect(workflow).toContain('[[ $current_version =~ $CALVER_PATTERN ]]')
  })

  test('accepts an existing release only when it targets the current commit', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )

    expect(workflow).toContain(
      `existing_target="$(gh release view "$tag_name" --json targetCommitish --jq .targetCommitish)"`
    )
    expect(workflow).toContain('[ "$existing_target" = "$GITHUB_SHA" ]')
  })

  test('exposes the entrypoint-wrapped CLI while persisting writer state', () => {
    const dockerfile = readFileSync(resolve(packageRoot, 'Dockerfile'), 'utf8')
    const compose = readFileSync(resolve(packageRoot, 'docker-compose.yml'), 'utf8')
    const publishWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/publish-quoter-bot-dockerhub.yml'),
      'utf8'
    )

    expect(dockerfile).toContain(
      'CMD ["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]'
    )
    // No ENTRYPOINT and no pinned state home: container commands carry the full entrypoint
    // invocation, and writer deployments must supply XDG_STATE_HOME themselves.
    expect(dockerfile).not.toContain('ENTRYPOINT')
    expect(dockerfile).not.toContain('XDG_STATE_HOME')
    expect(dockerfile).not.toContain('oven/bun')
    expect(compose).toContain('dockerfile: bots/quoter-bot/Dockerfile')
    expect(compose).toContain("'/usr/local/sbin/railway-entrypoint.sh',")
    expect(compose).toContain('XDG_STATE_HOME: /state')
    expect(compose).toContain('target: /state')
    expect(publishWorkflow).toContain('file: bots/quoter-bot/Dockerfile')
  })

  test('mounts an optional host keystore at the documented container path', () => {
    const compose = readFileSync(resolve(packageRoot, 'docker-compose.yml'), 'utf8')

    expect(compose).toContain('source: ${KEYSTORE_HOST_PATH:-/dev/null}')
    expect(compose).toContain('target: /run/secrets/quoter-bot-keystore.json')
    expect(compose).toContain('read_only: true')
  })

  test('passes standard AWS credentials through Compose for KMS signers', () => {
    const compose = readFileSync(resolve(packageRoot, 'docker-compose.yml'), 'utf8')

    expect(compose).toContain('AWS_ACCESS_KEY_ID:')
    expect(compose).toContain('AWS_SECRET_ACCESS_KEY:')
    expect(compose).toContain('AWS_SESSION_TOKEN:')
  })

  test('leaves latest alone when a newer release descends from the built commit', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/publish-quoter-bot-dockerhub.yml'),
      'utf8'
    )

    expect(workflow).toContain('git merge-base --is-ancestor "$COMMIT_SHA" "$commit"')
    expect(workflow).toContain('echo "move_latest=false"')
  })

  test('fails closed on deploy-label lookup errors', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )
    const labelLookup = workflow.slice(
      workflow.indexOf('- name: Check deploy label'),
      workflow.indexOf('- name: Check and create releases')
    )

    expect(labelLookup).toContain('gh api "repos/$REPO/commits/$bump_commit/pulls"')
    expect(labelLookup).not.toContain('|| true')
  })

  test('creates version-bump releases with the default token only when unlabeled', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )

    expect(workflow).toContain(
      "if: steps.version.outputs.bumped == 'true' && steps.label.outputs.deploy_labeled != 'true'"
    )
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}')
    // The chained-publish design needs no GitHub App: nothing depends on the release event
    // triggering other workflows.
    expect(workflow).not.toContain('create-github-app-token')
    expect(workflow).not.toContain('GIT_BOT_CLIENT_ID')
  })

  test('gives detached docker runs the full graceful shutdown window', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')
    const detachedRun = readme.slice(
      readme.indexOf('docker run --pull always'),
      readme.indexOf('\n```', readme.indexOf('docker run --pull always'))
    )

    expect(detachedRun).toContain('--stop-timeout 900')
    expect(detachedRun).toContain('-e XDG_STATE_HOME=/state')
  })
})
