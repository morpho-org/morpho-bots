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

  it('renders selector labels after custom pod labels so selectors cannot be overridden', async () => {
    const deployment = await readChartFile('templates/deployment.yaml')

    expect(deployment).toContain(`      labels:
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- include "quoter-bot.selectorLabels" . | nindent 8 }}`)
  })
})
