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

  test('documents manual releases from the same package version', () => {
    const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8')

    expect(readme).toContain(
      `gh release create "market-making-$(node -p "require('./package.json').version")" --generate-notes`
    )
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
