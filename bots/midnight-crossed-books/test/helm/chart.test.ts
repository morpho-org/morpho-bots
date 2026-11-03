import { execa } from 'execa'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const chartPath = fileURLToPath(new URL('../../helm/midnight-crossed-books/', import.meta.url))
const runtimeSecretKey = 'midnight-crossed-books/dev/8453/runtime'
const roleArn = 'arn:aws:iam::534545247992:role/tools-midnight-crossed-books-dev-8453'

const renderChart = (overrides: string[] = []) =>
  execa(
    'helm',
    [
      'template',
      'midnight-crossed-books',
      chartPath,
      '--set',
      'image.repository=534545247992.dkr.ecr.eu-west-3.amazonaws.com/bots/midnight-crossed-books',
      '--set',
      'image.tag=deadbeef',
      '--set',
      'serviceAccount.name=midnight-crossed-books-dev-8453',
      '--set',
      `serviceAccount.roleArn=${roleArn}`,
      '--set',
      `runtimeSecret.key=${runtimeSecretKey}`,
      ...overrides
    ],
    { reject: false }
  )

const resource = (manifest: string, kind: string) => {
  const document = manifest
    .split(/^---\s*$/m)
    .find(value => new RegExp(`^kind: ${kind}$`, 'm').test(value))
  if (!document) throw new Error(`helm template did not render ${kind}`)
  return document
}

describe('midnight-crossed-books Helm chart', () => {
  let renderedChart: Awaited<ReturnType<typeof renderChart>>

  beforeAll(async () => {
    renderedChart = await renderChart()
  }, 30_000)

  it('renders the runtime ExternalSecret and IRSA service account', async () => {
    const { exitCode, stdout } = renderedChart
    expect(exitCode).toBe(0)

    expect(resource(stdout, 'ExternalSecret')).toContain(`key: "${runtimeSecretKey}"`)
    expect(resource(stdout, 'ServiceAccount')).toContain(`eks.amazonaws.com/role-arn: "${roleArn}"`)
    const secretStore = resource(stdout, 'SecretStore')
    expect(secretStore).toContain('service: SecretsManager')
    expect(secretStore).toContain('name: "midnight-crossed-books-dev-8453"')
    expect(stdout).toContain('clusterIP: None')
    expect(stdout).toContain('app.kubernetes.io/name: midnight-crossed-books')
  })

  it('rejects replicas above one', async () => {
    const { exitCode, stderr } = await renderChart(['--set', 'replicas=2'])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain(
      'midnight-crossed-books: replicas must be 0 or 1, got 2: the resolver signs with one key'
    )
  }, 30_000)

  it('renders an ordered StatefulSet with a hardened security context', async () => {
    const { exitCode, stdout } = renderedChart
    expect(exitCode).toBe(0)

    const statefulSet = resource(stdout, 'StatefulSet')
    expect(statefulSet).toContain('podManagementPolicy: OrderedReady')
    expect(statefulSet).toContain('runAsNonRoot: true')
    expect(statefulSet).toContain('runAsUser: 1000')
    expect(statefulSet).toContain('runAsGroup: 1000')
    expect(statefulSet).toContain('type: RuntimeDefault')
    expect(statefulSet).toContain('allowPrivilegeEscalation: false')
    expect(statefulSet).toContain('readOnlyRootFilesystem: true')
    expect(statefulSet).toContain('drop:\n                - ALL')
    expect(stdout).not.toContain('kind: Deployment')
  })
})
