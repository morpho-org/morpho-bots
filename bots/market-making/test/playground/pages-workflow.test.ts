import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

const workflowPath = new URL(
  '../../../../.github/workflows/deploy-market-making-playground.yml',
  import.meta.url
)

const immutableAction = /^[^/]+\/[^@]+@[0-9a-f]{40}$/

interface Step {
  id?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface Job {
  environment?: Record<string, string>
  if?: string
  needs?: string
  permissions?: Record<string, string>
  steps: Step[]
  ['timeout-minutes']?: number
}

describe('market-making playground Pages workflow', () => {
  test('separates a read-only build from the code-free privileged deployment', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const workflow = parse(source)
    const trigger = workflow.on
    const build = workflow.jobs.build as Job
    const deploy = workflow.jobs.deploy as Job

    expect(Object.keys(trigger).toSorted()).toEqual(['push', 'workflow_dispatch'])
    expect(trigger).not.toHaveProperty('pull_request')
    expect(trigger.push.branches).toEqual(['main'])
    expect(trigger.push.paths).toEqual(
      expect.arrayContaining([
        'bots/market-making/**',
        'packages/bot-kit/**',
        'packages/logging/**',
        'packages/monitoring/**',
        'packages/observability/**',
        'packages/offers/**',
        'packages/utils/**',
        'packages/typescript-config/**',
        'package.json',
        'bun.lock',
        'bunfig.toml',
        '.npmrc',
        '.github/workflows/deploy-market-making-playground.yml'
      ])
    )
    expect(workflow.permissions).toEqual({})
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false })

    expect(Object.keys(workflow.jobs).toSorted()).toEqual(['build', 'deploy'])
    expect(build.if).toBe("github.ref == 'refs/heads/main'")
    expect(deploy.if).toBe("github.ref == 'refs/heads/main'")
    expect(build['timeout-minutes']).toBeGreaterThan(0)
    expect(deploy['timeout-minutes']).toBeGreaterThan(0)
    expect(build.permissions).toEqual({ contents: 'read' })
    expect(deploy.permissions).toEqual({ pages: 'write', 'id-token': 'write' })
    expect(deploy.needs).toBe('build')
    expect(deploy.environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}'
    })

    const checkout = build.steps.find(step => step.name === 'Check out repository')
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
      with: { 'persist-credentials': false }
    })
    expect(build.steps.find(step => step.name === 'Install dependencies')?.run).toBe(
      'bun install --frozen-lockfile'
    )
    expect(
      build.steps.find(step => step.name === 'Test playground at the GitHub Pages subpath')?.run
    ).toBe(
      'PLAYGROUND_SMOKE_BASE_PATH=/morpho-bots/ bun run --filter @morpho-org/market-making-bot playground:smoke:test'
    )
    expect(build.steps.find(step => step.name === 'Build playground')?.run).toBe(
      'bun run --filter @morpho-org/market-making-bot playground:build'
    )
    expect(build.steps.find(step => step.name === 'Upload GitHub Pages artifact')).toMatchObject({
      uses: 'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
      with: {
        name: 'github-pages',
        path: 'bots/market-making/playground/dist',
        'retention-days': 1
      }
    })

    expect(deploy.steps).toHaveLength(2)
    expect(deploy.steps.some(step => step.run || step.name === 'Check out repository')).toBe(false)
    expect(deploy.steps[0]).toMatchObject({
      name: 'Configure GitHub Pages',
      uses: 'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d',
      with: { enablement: true }
    })
    expect(deploy.steps[1]).toMatchObject({
      name: 'Deploy GitHub Pages',
      id: 'deployment',
      uses: 'actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128',
      with: { artifact_name: 'github-pages' }
    })

    const actions = [...build.steps, ...deploy.steps]
      .map(step => step.uses)
      .filter((uses): uses is string => uses !== undefined)
    expect(actions).toHaveLength(5)
    expect(actions.every(uses => immutableAction.test(uses))).toBe(true)
  })
})
