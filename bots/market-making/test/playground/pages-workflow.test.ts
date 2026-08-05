import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

const workflowPath = new URL(
  '../../../../.github/workflows/deploy-market-making-playground.yml',
  import.meta.url
)

describe('market-making playground Pages workflow', () => {
  test('keeps deployment constrained, pinned, and scoped to the built artifact', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = parse(source)
    const trigger = workflow.on
    const deploy = workflow.jobs.deploy

    expect(Object.keys(trigger).toSorted()).toEqual(['push', 'workflow_dispatch'])
    expect(trigger.push.branches).toEqual(['main'])
    expect(trigger.push.paths).toContain('bots/market-making/**')
    expect(workflow.permissions).toEqual({
      contents: 'read',
      pages: 'write',
      'id-token': 'write'
    })
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false })
    expect(deploy.environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}'
    })

    const uses = deploy.steps
      .filter((step: { uses?: string }) => step.uses)
      .map((step: { uses: string }) => step.uses)
    expect(uses).toEqual([
      'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d',
      'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
      'actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128'
    ])
    expect(
      deploy.steps.find((step: { name: string }) => step.name === 'Install dependencies').run
    ).toBe('bun install --frozen-lockfile')
    expect(
      deploy.steps.find((step: { name: string }) => step.name === 'Build playground').run
    ).toBe('bun run --filter @morpho-org/market-making-bot playground:build')
    expect(
      deploy.steps.find((step: { name: string }) => step.name === 'Upload GitHub Pages artifact')
        .with.path
    ).toBe('bots/market-making/playground/dist')
  })
})
