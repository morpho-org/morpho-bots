import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const chartPath = fileURLToPath(new URL('../../helm/blue-liquidation/', import.meta.url))
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
    'image.repository=example/blue-liquidation',
    '--set',
    'image.tag=deadbeef',
    '--set',
    'serviceAccount.name=blue-liquidation',
    '--set',
    'serviceAccount.roleArn=arn:aws:iam::000000000000:role/blue-liquidation',
    '--set',
    'runtimeSecret.key=blue-liquidation/dev/8453/runtime'
  ])
  return /^ {2}name: "(.+)"$/m.exec(stdout)?.[1]
}

describe('blue-liquidation Helm chart', () => {
  it('bounds the state claim name to 63 characters without merging long releases', async () => {
    const long = 'a'.repeat(50)
    const [short, first, second] = await Promise.all([
      claimNameOf('bot-8453'),
      claimNameOf(long),
      claimNameOf(`${long.slice(1)}b`)
    ])

    expect(short).toBe('bot-8453-blue-liquidation-state')
    expect(first).toBe(`${'a'.repeat(48)}-ccf410b4-state`)
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
      '{{ fail (printf "blue-liquidation: replicas must be 0 or 1, got %v: ' +
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

    expect(statefulSet).toContain('name: {{ include "blue-liquidation.fullname" . | quote }}')
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
    expect(pvc).toContain('name: {{ include "blue-liquidation.stateClaimName" . | quote }}')
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
        '            claimName: {{ include "blue-liquidation.stateClaimName" . | quote }}'
    )
  })

  it('mounts the state volume where KERNEL_STATE_DIR points, writable by the bot', async () => {
    const statefulSet = await readChartFile('templates/statefulset.yaml')

    expect(statefulSet).toContain(
      '            - name: state\n' +
        '              mountPath: {{ include "blue-liquidation.stateDirectory" . | quote }}'
    )
    expect(statefulSet).toContain(
      '            - name: KERNEL_STATE_DIR\n' +
        '              value: {{ include "blue-liquidation.stateDirectory" . | quote }}'
    )
    expect(statefulSet).toContain('{{- if eq .name "KERNEL_STATE_DIR" }}{{ fail ')
    expect(statefulSet).toContain(
      '        runAsGroup: 1000\n        fsGroup: 1000\n        fsGroupChangePolicy: OnRootMismatch\n'
    )
  })
})
