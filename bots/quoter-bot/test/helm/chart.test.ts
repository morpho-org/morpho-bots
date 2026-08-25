import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readChartFile = (path: string) =>
  readFile(new URL(`../../helm/quoter-bot/${path}`, import.meta.url), 'utf8')

describe('quoter-bot Helm chart', () => {
  it('mounts the config file under a directory that exists in the image', async () => {
    const [statefulSet, readme] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('README.md')
    ])

    expect(statefulSet).toContain('- /repo/bots/quoter-bot/quoter-bot.yaml')
    expect(statefulSet).toContain('mountPath: /repo/bots/quoter-bot/quoter-bot.yaml')
    expect(statefulSet).not.toContain('/config/quoter-bot.yaml')
    expect(readme).toContain('`--config /repo/bots/quoter-bot/quoter-bot.yaml`')
    expect(readme).not.toContain('/config/quoter-bot.yaml')
  })

  it('reports the actual mounted config path in the install notes', async () => {
    const notes = await readChartFile('templates/NOTES.txt')

    expect(notes).toContain('/repo/bots/quoter-bot/quoter-bot.yaml')
    expect(notes).not.toContain('/config/quoter-bot.yaml')
  })

  it('gives the default start command a bootstrap market in the quickstart', async () => {
    const readme = await readChartFile('README.md')

    expect(readme).not.toContain('  bootstrap: []')
    expect(readme).toContain(
      "  bootstrap:\n    - marketId: '0x5555555555555555555555555555555555555555555555555555555555555555'"
    )
  })

  it('creates the quickstart namespace before creating its signer Secret', async () => {
    const readme = await readChartFile('README.md')
    const createNamespace = readme.indexOf('kubectl create namespace quoter-bot')
    const createSecret = readme.indexOf(
      'kubectl --namespace quoter-bot create secret generic quoter-bot-signer'
    )

    expect(createNamespace).toBeGreaterThan(-1)
    expect(createSecret).toBeGreaterThan(createNamespace)
  })

  it('keeps the maker key out of kubectl argv in the quickstart', async () => {
    const readme = await readChartFile('README.md')

    expect(readme).not.toContain('--from-literal=makerPrivateKey')
    expect(readme).toContain('read -rs MAKER_PRIVATE_KEY')
    expect(readme).toContain('--from-file=makerPrivateKey=/dev/stdin')
  })

  it('runs the singleton writer as a StatefulSet with a portless headless Service', async () => {
    const [statefulSet, service] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('templates/service.yaml')
    ])

    expect(statefulSet).toContain('kind: StatefulSet')
    expect(statefulSet).toContain('replicas: 1')
    expect(statefulSet).toContain('serviceName: {{ include "quoter-bot.fullname" . }}')
    expect(statefulSet).not.toContain('kind: Deployment')
    expect(statefulSet).not.toContain('type: Recreate')
    expect(service).toContain('clusterIP: None')
    expect(service).not.toContain('ports:')
  })

  it('floors the grace period at the chart-managed receipt timeout plus a drain buffer', async () => {
    const statefulSet = await readChartFile('templates/statefulset.yaml')

    expect(statefulSet).toContain('dig "setup" "transactionReceiptTimeoutMs" 0 .Values.config')
    expect(statefulSet).toContain('add (div $receiptMs 1000) 120')
    expect(statefulSet).toContain('terminationGracePeriodSeconds: {{ $grace }}')
  })

  it('offers an upgrade-time restart annotation for mutable image tags', async () => {
    const [statefulSet, values] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])

    expect(values).toContain('forceRestartOnUpgrade: false')
    expect(statefulSet).toContain('{{- if .Values.forceRestartOnUpgrade }}')
    expect(statefulSet).toContain('quoter-bot.morpho.org/restarted-at:')
  })

  it('uses a chown-only init container instead of fsGroup for state ownership', async () => {
    const [statefulSet, values] = await Promise.all([
      readChartFile('templates/statefulset.yaml'),
      readChartFile('values.yaml')
    ])

    expect(values).toContain(`volumePermissions:\n  enabled: true`)
    expect(values).not.toContain('  fsGroup:')
    expect(values).not.toContain('  fsGroupChangePolicy:')
    expect(statefulSet).toContain('/usr/bin/chown')
    expect(statefulSet).toContain('.Values.podSecurityContext.runAsGroup | default 1000')
    expect(statefulSet).not.toContain('.Values.podSecurityContext.fsGroup')
  })

  it('renders custom pod annotations before the reserved config checksum', async () => {
    const statefulSet = await readChartFile('templates/statefulset.yaml')
    const customAnnotations = statefulSet.indexOf('{{- toYaml . | nindent 8 }}')
    const configChecksum = statefulSet.indexOf('checksum/config:')

    expect(customAnnotations).toBeGreaterThan(-1)
    expect(configChecksum).toBeGreaterThan(customAnnotations)
  })

  it('renders selector labels after custom pod labels so selectors cannot be overridden', async () => {
    const statefulSet = await readChartFile('templates/statefulset.yaml')

    expect(statefulSet).toContain(`      labels:
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- include "quoter-bot.selectorLabels" . | nindent 8 }}`)
  })
})
