import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chartPath = fileURLToPath(new URL('../../helm/midnight-liquidation/', import.meta.url))
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

describe('midnight-liquidation Helm chart', () => {
  it('rejects replicas above one', async () => {
    const [statefulSet, values] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])
    const guard = [
      '{{- if not (has (int .Values.replicas) (list 0 1)) }}',
      '{{ fail (printf "midnight-liquidation: replicas must be 0 or 1, got %v: ' +
        'every pod signs with the same key and keeps its own nonce cursor" .Values.replicas) }}',
      '{{- end }}'
    ].join('')

    expect(statefulSet).toContain(guard)
    expect(values).toContain('replicas: 1')
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

    expect(statefulSet).toContain('name: {{ include "midnight-liquidation.fullname" . | quote }}')
    expect(statefulSet).toContain('kind: StatefulSet')
    expect(statefulSet).toContain('podManagementPolicy: OrderedReady')
    expect(templates.join('\n')).not.toContain('kind: Deployment')
  })
})
