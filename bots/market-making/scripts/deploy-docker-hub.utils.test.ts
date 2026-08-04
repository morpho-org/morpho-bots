import { describe, expect, test } from 'bun:test'

import type { PublishEnvironment } from './deploy-docker-hub.utils'
import type { DockerPublishFailureReason } from './docker-publish.error'

import {
  buildPlatformValue,
  dockerHubCredentialsValue,
  dockerHubRepositoryValue,
  imageTagValue,
  publishTags
} from './deploy-docker-hub.utils'
import { DockerPublishError } from './docker-publish.error'

const reasonOf = (callback: () => unknown) => {
  try {
    callback()
  } catch (error) {
    if (error instanceof DockerPublishError) return error.reason
    throw error
  }
  return expect.unreachable('expected a DockerPublishError')
}

describe('dockerHubRepositoryValue', () => {
  test('accepts and trims a two-component Docker Hub repository', () => {
    const environment: PublishEnvironment = {
      DOCKERHUB_REPOSITORY: '  morphoorg/market-making-bot  '
    }

    expect(dockerHubRepositoryValue(environment)).toBe('morphoorg/market-making-bot')
  })

  test('accepts separator runs permitted by the distribution reference grammar', () => {
    expect(dockerHubRepositoryValue({ DOCKERHUB_REPOSITORY: 'my-org/bot__image-2.beta' })).toBe(
      'my-org/bot__image-2.beta'
    )
  })

  test('rejects a missing or blank repository', () => {
    expect(reasonOf(() => dockerHubRepositoryValue({}))).toBe('missing-repository')
    expect(reasonOf(() => dockerHubRepositoryValue({ DOCKERHUB_REPOSITORY: '   ' }))).toBe(
      'missing-repository'
    )
  })

  test.each([
    ['single component', 'market-making-bot'],
    ['uppercase', 'MorphoOrg/market-making-bot'],
    ['registry host prefix', 'ghcr.io/morphoorg/market-making-bot'],
    ['dotted namespace read as a registry host', 'ghcr.io/bot'],
    ['localhost namespace read as a registry host', 'localhost/bot'],
    ['trailing separator', 'morphoorg/market-making-'],
    ['embedded tag', 'morphoorg/bot:latest']
  ])('rejects %s', (_name, repository) => {
    expect(reasonOf(() => dockerHubRepositoryValue({ DOCKERHUB_REPOSITORY: repository }))).toBe(
      'invalid-repository'
    )
  })
})

describe('imageTagValue', () => {
  test('defaults to latest when unset or empty', () => {
    expect(imageTagValue({})).toBe('latest')
    expect(imageTagValue({ DOCKER_IMAGE_TAG: '  ' })).toBe('latest')
  })

  test('accepts and trims a valid tag', () => {
    expect(imageTagValue({ DOCKER_IMAGE_TAG: ' v1.2.3 ' })).toBe('v1.2.3')
    expect(imageTagValue({ DOCKER_IMAGE_TAG: '_underscore.START-9' })).toBe('_underscore.START-9')
  })

  test.each([
    ['leading period', '.hidden'],
    ['leading dash', '-flag'],
    ['slash', 'release/1'],
    ['overlong value', `v${'1'.repeat(128)}`]
  ])('rejects %s', (_name, tag) => {
    expect(reasonOf(() => imageTagValue({ DOCKER_IMAGE_TAG: tag }))).toBe('invalid-tag')
  })
})

describe('buildPlatformValue', () => {
  test('defaults to the linux/amd64 deploy target', () => {
    expect(buildPlatformValue({})).toBe('linux/amd64')
    expect(buildPlatformValue({ DOCKER_BUILD_PLATFORM: '' })).toBe('linux/amd64')
  })

  test('accepts os/arch and os/arch/variant platforms', () => {
    expect(buildPlatformValue({ DOCKER_BUILD_PLATFORM: 'linux/arm64' })).toBe('linux/arm64')
    expect(buildPlatformValue({ DOCKER_BUILD_PLATFORM: 'linux/arm/v7' })).toBe('linux/arm/v7')
  })

  test('rejects a platform without an architecture or with a list', () => {
    expect(reasonOf(() => buildPlatformValue({ DOCKER_BUILD_PLATFORM: 'linux' }))).toBe(
      'invalid-platform'
    )
    expect(
      reasonOf(() => buildPlatformValue({ DOCKER_BUILD_PLATFORM: 'linux/amd64,linux/arm64' }))
    ).toBe('invalid-platform')
  })
})

describe('dockerHubCredentialsValue', () => {
  test('returns undefined when neither credential variable is set', () => {
    expect(dockerHubCredentialsValue({})).toBeUndefined()
    expect(
      dockerHubCredentialsValue({ DOCKERHUB_USERNAME: ' ', DOCKERHUB_TOKEN: '' })
    ).toBeUndefined()
  })

  test('returns the trimmed pair when both are set', () => {
    expect(
      dockerHubCredentialsValue({ DOCKERHUB_USERNAME: ' maker ', DOCKERHUB_TOKEN: ' dckr_pat ' })
    ).toEqual({ username: 'maker', token: 'dckr_pat' })
  })

  test('rejects a partial pair in either direction', () => {
    expect(reasonOf(() => dockerHubCredentialsValue({ DOCKERHUB_USERNAME: 'maker' }))).toBe(
      'partial-credentials'
    )
    expect(reasonOf(() => dockerHubCredentialsValue({ DOCKERHUB_TOKEN: 'dckr_pat' }))).toBe(
      'partial-credentials'
    )
  })
})

describe('publishTags', () => {
  test('adds a lowercase traceability tag after the primary tag', () => {
    expect(publishTags('latest', { shortSha: 'ABC1234', dirty: false })).toEqual([
      'latest',
      'git-abc1234'
    ])
  })

  test('marks uncommitted working trees as dirty', () => {
    expect(publishTags('v1.2.3', { shortSha: 'abc1234', dirty: true })).toEqual([
      'v1.2.3',
      'git-abc1234-dirty'
    ])
  })

  test('skips the traceability tag without a usable git description', () => {
    expect(publishTags('latest')).toEqual(['latest'])
    expect(publishTags('latest', { shortSha: 'not-hex', dirty: false })).toEqual(['latest'])
  })

  test('never pushes one tag twice when the primary tag already is the traceability tag', () => {
    expect(publishTags('git-abc1234', { shortSha: 'abc1234', dirty: false })).toEqual([
      'git-abc1234'
    ])
  })
})

describe('DockerPublishError', () => {
  test('maps each reason to a stable sanitized message', () => {
    const error = new DockerPublishError('missing-repository')

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'DockerPublishError',
      code: 'DOCKER_PUBLISH_ERROR',
      kind: 'tooling',
      reason: 'missing-repository',
      message: 'Missing required env var: DOCKERHUB_REPOSITORY'
    })
  })

  test('gives every reason its own non-empty message', () => {
    const reasons: DockerPublishFailureReason[] = [
      'docker-cli-missing',
      'missing-repository',
      'invalid-repository',
      'invalid-tag',
      'invalid-platform',
      'partial-credentials',
      'login-failed',
      'build-failed',
      'push-failed'
    ]
    const messages = reasons.map(reason => new DockerPublishError(reason).message)

    expect(messages.every(message => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(reasons.length)
  })

  test('appends only the script-controlled subject and retains the cause privately', () => {
    const cause = { stderr: 'third-party stderr' }
    const error = new DockerPublishError('push-failed', {
      subject: 'morphoorg/bot:latest',
      cause
    })

    expect(error.message).toBe(
      'docker push failed; see the docker output above (morphoorg/bot:latest)'
    )
    expect(error.subject).toBe('morphoorg/bot:latest')
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain('third-party stderr')
  })
})
