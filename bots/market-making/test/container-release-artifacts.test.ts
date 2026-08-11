import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')

describe('market-making container release artifacts', () => {
  test('cuts labeled production releases from the package version', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-production.yml'),
      'utf8'
    )
    const marketMakingRelease = workflow.slice(workflow.indexOf('  Release-market-making:'))

    expect(marketMakingRelease).toContain(
      `version="$(node -p "require('./bots/market-making/package.json').version")"`
    )
    expect(marketMakingRelease).toContain('tag="${BOT}-${version}"')
    expect(marketMakingRelease).not.toContain('date="$(date -u +%Y.%m.%d)"')
  })

  test('documents manual releases from the same package version and commit', () => {
    const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8')

    expect(readme).toContain(
      `gh release create "market-making-$(node -p "require('./package.json').version")" --target "$(git rev-parse HEAD)" --generate-notes`
    )
  })

  test('disables Husky in every workspace Docker install', () => {
    for (const dockerfilePath of [
      'bots/blue-liquidation/Dockerfile',
      'bots/market-making/Dockerfile',
      'bots/market-making/Dockerfile.release',
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
      resolve(repositoryRoot, '.github/workflows/deploy-market-making.yml'),
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
      resolve(repositoryRoot, '.github/workflows/deploy-market-making.yml'),
      'utf8'
    )

    expect(dockerfile).toContain('RUN mkdir -p /repo /state')
    expect(dockerfile).toContain('RUN pnpm --filter @morpho-org/market-making-bot run build')
    expect(dockerfile).not.toContain('pnpm -r --if-present run build')
    expect(dockerfile).toContain('ENV XDG_STATE_HOME=/state')
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/src/index.js"]')
    expect(dockerfile).toContain('CMD ["start", "--verbose"]')
    expect(dockerfile).not.toContain('oven/bun')
    expect(compose).toContain('dockerfile: bots/market-making/Dockerfile.release')
    expect(publishWorkflow).toContain('--file bots/market-making/Dockerfile.release')
  })

  test('mounts an optional host keystore at the documented container path', () => {
    const compose = readFileSync(resolve(packageRoot, 'docker-compose.yml'), 'utf8')

    expect(compose).toContain('source: ${KEYSTORE_HOST_PATH:-/dev/null}')
    expect(compose).toContain('target: /run/secrets/market-making-keystore.json')
    expect(compose).toContain('read_only: true')
  })

  test('gives detached docker runs the full graceful shutdown window', () => {
    const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8')
    const detachedRun = readme.slice(
      readme.indexOf('docker run --pull always'),
      readme.indexOf('\n```', readme.indexOf('docker run --pull always'))
    )

    expect(detachedRun).toContain('--stop-timeout 900')
  })
})
