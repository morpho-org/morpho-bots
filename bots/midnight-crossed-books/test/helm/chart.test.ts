import { execa } from 'execa'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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

const readChartFile = (path: string) => readFile(resolve(chartPath, path), 'utf8')

const readDirectory = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(entry => {
        const entryPath = resolve(path, entry.name)
        return entry.isDirectory() ? readDirectory(entryPath) : readFile(entryPath, 'utf8')
      })
    )
  ).flat()
}

const claimNameOf = async (release: string) => {
  const { stdout } = await promisify(execFile)('helm', [
    'template',
    release,
    chartPath,
    '--show-only',
    'templates/pvc.yaml',
    '--set',
    'image.repository=example/midnight-crossed-books',
    '--set',
    'image.tag=deadbeef',
    '--set',
    'serviceAccount.name=midnight-crossed-books',
    '--set',
    'serviceAccount.roleArn=arn:aws:iam::000000000000:role/midnight-crossed-books',
    '--set',
    'runtimeSecret.key=midnight-crossed-books/dev/8453/runtime'
  ])
  return /^ {2}name: "(.+)"$/m.exec(stdout)?.[1]
}

const renderStatefulSet = async (...extra: string[]) => {
  const { stdout } = await promisify(execFile)('helm', [
    'template',
    'bot-8453',
    chartPath,
    '--show-only',
    'templates/statefulset.yaml',
    '--set',
    'image.repository=example/midnight-crossed-books',
    '--set',
    'image.tag=deadbeef',
    '--set',
    'serviceAccount.name=midnight-crossed-books',
    '--set',
    'serviceAccount.roleArn=arn:aws:iam::000000000000:role/midnight-crossed-books',
    '--set',
    'runtimeSecret.key=midnight-crossed-books/dev/8453/runtime',
    ...extra
  ])
  return stdout
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

  it('bounds the state claim name to 63 characters without merging long releases', async () => {
    const long = 'a'.repeat(50)
    const [short, first, second] = await Promise.all([
      claimNameOf('bot-8453'),
      claimNameOf(long),
      claimNameOf(`${long.slice(1)}b`)
    ])

    expect(short).toBe('bot-8453-midnight-crossed-books-state')
    expect(first).toBe(`${'a'.repeat(48)}-a9808e52-state`)
    expect(second?.length).toBe(63)
    expect(second).not.toBe(first)
  }, 30_000)

  it('rejects replicas above one', async () => {
    const [statefulSet, values] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])
    const guard = [
      '{{- if not (has (int .Values.replicas) (list 0 1)) }}',
      '{{ fail (printf "midnight-crossed-books: replicas must be 0 or 1, got %v: ' +
        'every pod signs with the same key and keeps its own nonce cursor" .Values.replicas) }}',
      '{{- end }}'
    ].join('')

    expect(statefulSet).toContain(guard)
    expect(values).toContain('replicas: 1')
  })

  it('gives a stopping pod two minutes to settle what the kernel holds', async () => {
    const [statefulSet, values] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])

    expect(statefulSet).toContain(
      'terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}'
    )
    expect(values).toContain('\nterminationGracePeriodSeconds: 120\n')
  })

  it('does not allow name overrides in chart files', async () => {
    const chartFiles = await readDirectory(chartPath)

    expect(chartFiles.join('\n')).not.toMatch(/nameOverride|fullnameOverride/)
  })

  it('keeps the ordered StatefulSet and avoids Deployments', async () => {
    const [statefulSet, templates] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readDirectory(resolve(chartPath, 'templates'))
    ])

    expect(statefulSet).toContain('name: {{ include "midnight-crossed-books.fullname" . | quote }}')
    expect(statefulSet).toContain('kind: StatefulSet')
    expect(statefulSet).toContain('podManagementPolicy: OrderedReady')
    expect(templates.join('\n')).not.toContain('kind: Deployment')
  })

  it('keeps the kernel ledger on a standalone claim that outlives the release', async () => {
    const [pvc, statefulSet, values] = await Promise.all([
      readChartFile('templates/pvc.yaml'),
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])

    expect(pvc).toContain('kind: PersistentVolumeClaim')
    expect(pvc).toContain('name: {{ include "midnight-crossed-books.stateClaimName" . | quote }}')
    expect(pvc).toContain('helm.sh/resource-policy: keep')
    expect(pvc).toContain('argocd.argoproj.io/sync-options: Delete=false,Prune=false')
    expect(pvc).toContain(
      'storageClassName: {{ required "state.storageClass is required" .Values.state.storageClass | quote }}'
    )
    expect(pvc).toContain(
      'storage: {{ required "state.size is required" .Values.state.size | quote }}'
    )
    expect(values).toContain('state:\n  storageClass: tools-gp3\n  size: 10Gi\n')
    expect(statefulSet).not.toContain('volumeClaimTemplates')
    expect(statefulSet).toContain(
      '        - name: state\n' +
        '          persistentVolumeClaim:\n' +
        '            claimName: {{ include "midnight-crossed-books.stateClaimName" . | quote }}'
    )
  })

  it('mounts the state volume where KERNEL_STATE_DIR points, writable by the bot', async () => {
    const statefulSet = await readChartFile('templates/statefulset.yaml')

    expect(statefulSet).toContain(
      '            - name: state\n' +
        '              mountPath: {{ include "midnight-crossed-books.stateDirectory" . | quote }}'
    )
    expect(statefulSet).toContain(
      '            - name: KERNEL_STATE_DIR\n' +
        '              value: {{ include "midnight-crossed-books.stateDirectory" . | quote }}'
    )
    expect(statefulSet).toContain('{{- if eq .name "KERNEL_STATE_DIR" }}{{ fail ')
    expect(statefulSet).toContain(
      '        runAsGroup: 1000\n        fsGroup: 1000\n        fsGroupChangePolicy: OnRootMismatch\n'
    )
  })

  it('sets the journal run cap from the state values, and refuses one set in env', async () => {
    const [rendered, raised] = await Promise.all([
      renderStatefulSet(),
      renderStatefulSet('--set-string', 'state.journalRunCapBytes=2147483648')
    ])

    expect(rendered).toContain(
      '            - name: JOURNAL_RUN_CAP_BYTES\n              value: "1073741824"\n'
    )
    expect(raised).toContain('value: "2147483648"')
    await expect(
      renderStatefulSet('--set', 'env[0].name=JOURNAL_RUN_CAP_BYTES', '--set', 'env[0].value=1')
    ).rejects.toThrow('env must not set JOURNAL_RUN_CAP_BYTES')
    await expect(renderStatefulSet('--set', 'state.journalRunCapBytes=null')).rejects.toThrow(
      'state.journalRunCapBytes is required'
    )
    for (const invalid of [
      '--set-json=state.journalRunCapBytes=67108864.5',
      '--set=state.journalRunCapBytes=1073741824',
      '--set-string=state.journalRunCapBytes=1Gi'
    ])
      await expect(renderStatefulSet(invalid)).rejects.toThrow(
        'state.journalRunCapBytes must be a quoted whole number of bytes'
      )
  }, 30_000)
})
