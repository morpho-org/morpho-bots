/** Stable reason codes selecting the sanitized Docker Hub publish failure messages. */
export type DockerPublishFailureReason =
  | 'docker-cli-missing'
  | 'missing-repository'
  | 'invalid-repository'
  | 'invalid-tag'
  | 'invalid-platform'
  | 'partial-credentials'
  | 'login-failed'
  | 'build-failed'
  | 'push-failed'

/** Signals one expected Docker Hub publish tooling failure with an operator-safe message. */
export class DockerPublishError extends Error {
  readonly code = 'DOCKER_PUBLISH_ERROR'
  readonly kind = 'tooling'
  /** Optional script-controlled, already-validated identifier such as a pushed image reference. */
  readonly subject: string | undefined

  /**
   * Creates a publish failure whose message never contains credentials or third-party output.
   * @param reason - Stable reason code used to select the sanitized error message.
   * @param options - Optional pre-validated subject appended to the message and a retained
   * third-party cause for local inspection; the cause never contributes to the message.
   */
  constructor(
    readonly reason: DockerPublishFailureReason,
    options: { subject?: string; cause?: unknown } = {}
  ) {
    const messages = {
      'docker-cli-missing': 'Docker CLI not found. Install it: https://docs.docker.com/get-docker',
      'missing-repository': 'Missing required env var: DOCKERHUB_REPOSITORY',
      'invalid-repository':
        'DOCKERHUB_REPOSITORY must be a lowercase Docker Hub <namespace>/<name> repository',
      'invalid-tag': 'DOCKER_IMAGE_TAG must be a valid Docker tag of at most 128 characters',
      'invalid-platform': 'DOCKER_BUILD_PLATFORM must be an <os>/<arch>[/<variant>] platform',
      'partial-credentials':
        'Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN together, or neither to reuse a docker login',
      'login-failed': 'docker login to Docker Hub failed',
      'build-failed': 'docker build failed; see the docker output above',
      'push-failed': 'docker push failed; see the docker output above'
    } as const
    super(options.subject ? `${messages[reason]} (${options.subject})` : messages[reason], {
      cause: options.cause
    })
    this.name = 'DockerPublishError'
    this.subject = options.subject
  }
}
