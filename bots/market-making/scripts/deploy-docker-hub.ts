/**
 * Builds the market-making bot image and publishes it to Docker Hub from the CLI:
 *
 *   DOCKERHUB_REPOSITORY=<namespace>/<name> \
 *     bun run --filter @morpho-org/market-making-bot deploy:docker-hub
 *
 * Inputs (environment):
 *   - DOCKERHUB_REPOSITORY (required) — target repository, e.g. `morphoorg/market-making-bot`.
 *   - DOCKER_IMAGE_TAG (optional) — movable primary tag; defaults to `latest`.
 *   - DOCKERHUB_USERNAME / DOCKERHUB_TOKEN (optional pair) — non-interactive `docker login`; the
 *     token is piped via stdin so it never appears in argv or logs. With neither set, the push
 *     reuses the operator's existing `docker login` session.
 *   - DOCKER_BUILD_PLATFORM (optional) — single image platform; defaults to `linux/amd64` (the
 *     deploy target), so Apple Silicon hosts cross-build instead of publishing arm64-only images.
 *
 * Every publish also pushes an immutable `git-<shortsha>` traceability tag (suffixed `-dirty` when
 * the working tree has uncommitted changes) so a running container is attributable to its commit.
 * The build context is the repo root so the bun workspace (packages/*) resolves — mirrors the
 * Dockerfile header and the docker-compose context. Docker's own build/push output streams to the
 * terminal; expected failures exit 1 with a sanitized `DockerPublishError` message.
 */
import { tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

import type { DockerHubCredentials, WorkingTreeDescription } from './deploy-docker-hub.utils'

import {
  buildPlatformValue,
  dockerHubCredentialsValue,
  dockerHubRepositoryValue,
  imageTagValue,
  publishTags
} from './deploy-docker-hub.utils'
import { DockerPublishError } from './docker-publish.error'

// Repo root is three levels up from this file (scripts → market-making → bots → repo root).
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const DOCKERFILE_PATH = 'bots/market-making/Dockerfile'

const assertDockerCli = async () => {
  const { error } = await tryCatch(Promise.resolve($`docker --version`.quiet()))
  if (error) throw new DockerPublishError('docker-cli-missing', { cause: error })
}

// Best-effort git description for the traceability tag; undefined outside a usable git checkout.
// Unknown dirtiness counts as dirty so a non-reproducible image is never marked clean.
const describeWorkingTree = async (): Promise<WorkingTreeDescription | undefined> => {
  const revParse = await tryCatch(
    Promise.resolve($`git rev-parse --short HEAD`.cwd(REPO_ROOT).quiet().text())
  )
  const shortSha = revParse.data?.trim()
  if (revParse.error || !shortSha) return undefined
  const status = await tryCatch(
    Promise.resolve($`git status --porcelain`.cwd(REPO_ROOT).quiet().text())
  )
  return { shortSha, dirty: status.error !== null || Boolean(status.data?.trim()) }
}

// The token is piped via stdin (never argv) and login output is suppressed; the session persists
// like a manual `docker login`, so this script never logs out an operator.
const login = async (credentials: DockerHubCredentials) => {
  const { error } = await tryCatch(
    Promise.resolve(
      $`docker login --username ${credentials.username} --password-stdin < ${Buffer.from(credentials.token, 'utf8')}`.quiet()
    )
  )
  if (error) throw new DockerPublishError('login-failed', { cause: error })
  console.log(`Logged in to Docker Hub as ${credentials.username}.`)
}

// Build and push stream docker's own progress output; failures surface there, so the typed error
// only adds the failed step (and pushed reference) without duplicating third-party text.
const buildImage = async (references: string[], platform: string) => {
  const tagArguments = references.flatMap(reference => ['--tag', reference])
  const { error } = await tryCatch(
    Promise.resolve(
      $`docker build --platform ${platform} --file ${DOCKERFILE_PATH} ${tagArguments} .`.cwd(
        REPO_ROOT
      )
    )
  )
  if (error) throw new DockerPublishError('build-failed', { cause: error })
}

const pushImage = async (reference: string) => {
  const { error } = await tryCatch(Promise.resolve($`docker push ${reference}`))
  if (error) throw new DockerPublishError('push-failed', { subject: reference, cause: error })
}

const run = async () => {
  await assertDockerCli()
  const repository = dockerHubRepositoryValue(Bun.env)
  const platform = buildPlatformValue(Bun.env)
  const credentials = dockerHubCredentialsValue(Bun.env)

  const workingTree = await describeWorkingTree()
  if (workingTree === undefined) {
    console.warn('Could not describe the git working tree; publishing without a git-<sha> tag.')
  } else if (workingTree.dirty) {
    console.warn('Working tree has uncommitted changes; the traceability tag ends in -dirty.')
  }
  const references = publishTags(imageTagValue(Bun.env), workingTree).map(
    tag => `${repository}:${tag}`
  )

  if (credentials) await login(credentials)
  else console.log('No DOCKERHUB_USERNAME/DOCKERHUB_TOKEN; reusing the current docker login.')

  console.log(`Building ${references.join(' and ')} for ${platform} from the repo root…`)
  await buildImage(references, platform)
  for (const reference of references) {
    console.log(`Pushing ${reference}…`)
    await pushImage(reference)
  }

  console.log('')
  console.log('=== Published ===')
  for (const reference of references) console.log(`  docker.io/${reference}`)
}

if (import.meta.main) {
  try {
    await run()
  } catch (error) {
    // Expected tooling failures exit with the sanitized message only; docker/git details already
    // streamed above. Unexpected errors rethrow with their complete context.
    if (!(error instanceof DockerPublishError)) throw error
    console.error(`deploy-docker-hub failed: ${error.message}`)
    process.exitCode = 1
  }
}
