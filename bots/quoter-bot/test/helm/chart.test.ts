import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readChartFile = (path: string) =>
  readFile(new URL(`../../helm/quoter-bot/${path}`, import.meta.url), 'utf8')

describe('quoter-bot Helm chart', () => {
  it('mounts the config file under a directory that exists in the image', async () => {
    const [deployment, readme] = await Promise.all([
      readChartFile('templates/deployment.yaml'),
      readChartFile('README.md')
    ])

    expect(deployment).toContain('- /repo/bots/quoter-bot/quoter-bot.yaml')
    expect(deployment).toContain('mountPath: /repo/bots/quoter-bot/quoter-bot.yaml')
    expect(deployment).not.toContain('/config/quoter-bot.yaml')
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

  it('uses a chown-only init container instead of fsGroup for state ownership', async () => {
    const [deployment, values] = await Promise.all([
      readChartFile('templates/deployment.yaml'),
      readChartFile('values.yaml')
    ])

    expect(values).toContain(`volumePermissions:\n  enabled: true`)
    expect(values).not.toContain('  fsGroup:')
    expect(values).not.toContain('  fsGroupChangePolicy:')
    expect(deployment).toContain('/usr/bin/chown')
    expect(deployment).toContain('.Values.podSecurityContext.runAsGroup | default 1000')
    expect(deployment).not.toContain('.Values.podSecurityContext.fsGroup')
  })

  it('renders custom pod annotations before the reserved config checksum', async () => {
    const deployment = await readChartFile('templates/deployment.yaml')
    const customAnnotations = deployment.indexOf('{{- toYaml . | nindent 8 }}')
    const configChecksum = deployment.indexOf('checksum/config:')

    expect(customAnnotations).toBeGreaterThan(-1)
    expect(configChecksum).toBeGreaterThan(customAnnotations)
  })

  it('renders selector labels after custom pod labels so selectors cannot be overridden', async () => {
    const deployment = await readChartFile('templates/deployment.yaml')

    expect(deployment).toContain(`      labels:
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- include "quoter-bot.selectorLabels" . | nindent 8 }}`)
  })
})
