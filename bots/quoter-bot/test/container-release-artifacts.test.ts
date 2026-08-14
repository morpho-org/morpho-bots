import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')

describe('quoter-bot container release artifacts', () => {
  test('cuts labeled production releases from the package version', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-production.yml'),
      'utf8'
    )
    const quoterBotRelease = workflow.slice(workflow.indexOf('  Release-quoter-bot:'))

    expect(quoterBotRelease).toContain(
      `version="$(node -p "require('./bots/quoter-bot/package.json').version")"`
    )
    expect(quoterBotRelease).toContain('tag="${BOT}-${version}"')
    expect(quoterBotRelease).not.toContain('date="$(date -u +%Y.%m.%d)"')
  })

  test('documents repo-root manual releases from the bot package version and commit', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')

    expect(readme).toContain(
      `gh release create "quoter-bot-$(node -p "require('./bots/quoter-bot/package.json').version")" --target "$(git rev-parse HEAD)" --generate-notes`
    )
  })

  test('documents the quoter-bot release tag environment policy', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')

    expect(readme).toContain('tags matching `quoter-bot-*`')
    expect(readme).not.toContain('tags matching `market-making-*`')
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

  test('documents that only the highest stable release moves latest', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8').replace(
      /\s+/g,
      ' '
    )

    expect(readme).toContain(
      '`latest` (moved only when the release is the highest stable CalVer version)'
    )
    expect(readme).not.toContain('`latest` (moved unless the release is marked a prerelease)')
  })

  test('documents shared state for read-only deployment inspections', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8').replace(
      /\s+/g,
      ' '
    )

    expect(readme).toContain(
      'Read-only inspections of an existing deployment should mount the same `/state` volume'
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

  test('prevents manual dispatches from moving immutable release and commit tags', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-quoter-bot.yml'),
      'utf8'
    )

    expect(workflow).toContain(
      'if [[ "$DISPATCH_TAG" == quoter-bot-* || "$DISPATCH_TAG" == git-* ]]'
    )
    expect(workflow).toContain('refusing to overwrite immutable release or commit tag')
  })

  test('disables Husky in every workspace Docker install', () => {
    for (const dockerfilePath of [
      'bots/blue-liquidation/Dockerfile',
      'bots/quoter-bot/Dockerfile',
      'bots/quoter-bot/Dockerfile.release',
      'bots/midnight-crossed-books/Dockerfile',
      'bots/midnight-liquidation/Dockerfile'
    ]) {
      const dockerfile = readFileSync(resolve(repositoryRoot, dockerfilePath), 'utf8')

      expect(dockerfile).toContain('ENV HUSKY=0')
      expect(dockerfile).toContain('RUN pnpm install --frozen-lockfile')
    }
  })

  test('validates release CalVer before publishing the operator image', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-quoter-bot.yml'),
      'utf8'
    )

    expect(workflow).toContain(`CALVER_PATTERN="^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[1-9][0-9]*$"`)
    expect(workflow).toContain('[[ "$package_version" =~ $CALVER_PATTERN ]]')
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

  test('exposes the built Node CLI while persisting writer state', () => {
    const dockerfile = readFileSync(resolve(packageRoot, 'Dockerfile.release'), 'utf8')
    const compose = readFileSync(resolve(packageRoot, 'docker-compose.yml'), 'utf8')
    const publishWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-quoter-bot.yml'),
      'utf8'
    )

    expect(dockerfile).toContain('RUN mkdir -p /repo /state')
    expect(dockerfile).toContain('RUN pnpm --filter @morpho-org/quoter-bot run build')
    expect(dockerfile).not.toContain('pnpm -r --if-present run build')
    expect(dockerfile).toContain('ENV XDG_STATE_HOME=/state')
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/src/index.js"]')
    expect(dockerfile).toContain('CMD ["start", "--verbose"]')
    expect(dockerfile).not.toContain('oven/bun')
    expect(compose).toContain('dockerfile: bots/quoter-bot/Dockerfile.release')
    expect(publishWorkflow).toContain('--file bots/quoter-bot/Dockerfile.release')
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

  test('moves latest only for the highest stable quoter-bot CalVer release', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-quoter-bot.yml'),
      'utf8'
    )

    expect(workflow).toContain('highest_stable_tag=')
    expect(workflow).toContain('[ "$RELEASE_TAG" = "$highest_stable_tag" ]')
    expect(workflow).not.toContain('[ "$PRERELEASE" = "true" ] || tags+=("latest")')
  })

  test('fails closed on deploy-label lookup errors', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )
    const labelLookup = workflow.slice(
      workflow.indexOf('- name: Check deploy label'),
      workflow.indexOf('- name: Mint app installation token')
    )

    expect(labelLookup).toContain('gh api "repos/$REPO/commits/$bump_commit/pulls"')
    expect(labelLookup).not.toContain('|| true')
  })

  test('mints an app token only after detecting a pending version bump', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/tag-releases.yml'),
      'utf8'
    )
    const detectIndex = workflow.indexOf('- name: Detect quoter-bot version bump')
    const mintIndex = workflow.indexOf('- name: Mint app installation token')

    expect(detectIndex).toBeGreaterThan(-1)
    expect(mintIndex).toBeGreaterThan(detectIndex)
    expect(
      workflow.slice(mintIndex, workflow.indexOf('- name: Check and create releases'))
    ).toContain(
      "if: steps.version.outputs.bumped == 'true' && steps.label.outputs.deploy_labeled != 'true'"
    )
  })

  test('gives detached docker runs the full graceful shutdown window', () => {
    const readme = readFileSync(resolve(packageRoot, 'docs/reference.md'), 'utf8')
    const detachedRun = readme.slice(
      readme.indexOf('docker run --pull always'),
      readme.indexOf('\n```', readme.indexOf('docker run --pull always'))
    )

    expect(detachedRun).toContain('--stop-timeout 900')
  })
})
