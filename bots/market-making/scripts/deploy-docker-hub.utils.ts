import { DockerPublishError } from './docker-publish.error'

/** String-valued process environment boundary read by the Docker Hub publish tooling. */
export type PublishEnvironment = Record<string, string | undefined>

/** Non-interactive Docker Hub login pair supplied through the environment. */
export type DockerHubCredentials = { username: string; token: string }

/** Traceability description of the git working tree an image is built from. */
export type WorkingTreeDescription = { shortSha: string; dirty: boolean }

// Docker Hub repositories are exactly two components. The namespace additionally bans dots (and
// `localhost` below): docker's reference parser reads a dotted first component as a registry host,
// which would silently push somewhere other than Docker Hub. Names keep the distribution grammar.
const NAMESPACE_COMPONENT = '[a-z0-9]+(?:(?:_|__|-+)[a-z0-9]+)*'
const NAME_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const REPOSITORY_PATTERN = new RegExp(`^${NAMESPACE_COMPONENT}/${NAME_COMPONENT}$`)
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const PLATFORM_PATTERN = /^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/
const SHORT_SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/

/**
 * Reads and validates the required Docker Hub target repository.
 * @param environment - Untrusted process environment values.
 * @returns The trimmed `<namespace>/<name>` repository.
 * @throws `DockerPublishError` when `DOCKERHUB_REPOSITORY` is absent, empty, or not a two-component
 * lowercase Docker Hub repository reference; dotted or `localhost` namespaces are rejected because
 * docker would read them as a registry host and push somewhere other than Docker Hub.
 */
export const dockerHubRepositoryValue = (environment: PublishEnvironment): string => {
  const value = environment.DOCKERHUB_REPOSITORY?.trim()
  if (!value) throw new DockerPublishError('missing-repository')
  if (!REPOSITORY_PATTERN.test(value) || value.startsWith('localhost/')) {
    throw new DockerPublishError('invalid-repository')
  }
  return value
}

/**
 * Reads the optional primary image tag.
 * @param environment - Untrusted process environment values.
 * @returns The trimmed `DOCKER_IMAGE_TAG` value, or `latest` when unset or empty.
 * @throws `DockerPublishError` when the supplied value is not a valid Docker tag.
 */
export const imageTagValue = (environment: PublishEnvironment): string => {
  const value = environment.DOCKER_IMAGE_TAG?.trim()
  if (!value) return 'latest'
  if (!TAG_PATTERN.test(value)) throw new DockerPublishError('invalid-tag')
  return value
}

/**
 * Reads the optional single image build platform.
 * @param environment - Untrusted process environment values.
 * @returns The trimmed `DOCKER_BUILD_PLATFORM` value, or the `linux/amd64` deploy default.
 * @throws `DockerPublishError` when the supplied value is not an `<os>/<arch>[/<variant>]` platform.
 */
export const buildPlatformValue = (environment: PublishEnvironment): string => {
  const value = environment.DOCKER_BUILD_PLATFORM?.trim()
  if (!value) return 'linux/amd64'
  if (!PLATFORM_PATTERN.test(value)) throw new DockerPublishError('invalid-platform')
  return value
}

/**
 * Reads the optional non-interactive Docker Hub credential pair.
 * @param environment - Untrusted process environment values.
 * @returns The trimmed username/token pair, or `undefined` when neither variable is set so the
 * publish reuses the operator's existing `docker login` session.
 * @throws `DockerPublishError` when exactly one of `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` is
 * supplied; a partial pair is always a configuration mistake.
 */
export const dockerHubCredentialsValue = (
  environment: PublishEnvironment
): DockerHubCredentials | undefined => {
  const username = environment.DOCKERHUB_USERNAME?.trim()
  const token = environment.DOCKERHUB_TOKEN?.trim()
  if (!username && !token) return undefined
  if (!username || !token) throw new DockerPublishError('partial-credentials')
  return { username, token }
}

/**
 * Derives the complete ordered tag list one publish pushes.
 * @param primaryTag - Already-validated movable tag, `latest` by default.
 * @param workingTree - Optional git description adding an immutable `git-<shortsha>` traceability
 * tag, suffixed `-dirty` when the tree holds uncommitted changes.
 * @returns Unique tags with the primary tag first; the traceability tag is skipped when the git
 * description is unavailable or its hash is not hexadecimal.
 */
export const publishTags = (primaryTag: string, workingTree?: WorkingTreeDescription): string[] => {
  if (workingTree === undefined || !SHORT_SHA_PATTERN.test(workingTree.shortSha)) {
    return [primaryTag]
  }
  const traceabilityTag = `git-${workingTree.shortSha.toLowerCase()}${workingTree.dirty ? '-dirty' : ''}`
  return traceabilityTag === primaryTag ? [primaryTag] : [primaryTag, traceabilityTag]
}
