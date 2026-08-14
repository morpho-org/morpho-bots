import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  assertFreshRailwayReferenceProvisioning,
  assertFullRailwaySignerProvisioning,
  isNonEmptyJsonArray,
  isTerminalRailwayDeploymentStatus,
  parseLatestRailwayDeployment,
  parseRailwayServices,
  parseRailwayVolumes,
  selectNewRailwayDeployment,
  synchronizedOptionalRailwayVariables
} from '../../scripts/railway.utils'

type DockerInstruction = { keyword: string; value: string }

const parseDockerfile = (source: string): DockerInstruction[] => {
  const instructions: DockerInstruction[] = []
  let logicalLine = ''

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    logicalLine += `${logicalLine ? ' ' : ''}${trimmed.replace(/\\$/, '').trimEnd()}`
    if (trimmed.endsWith('\\')) continue

    const match = logicalLine.match(/^(\S+)\s+(.+)$/)
    if (!match) throw new Error(`Invalid Dockerfile instruction: ${logicalLine}`)
    instructions.push({ keyword: match[1]!.toUpperCase(), value: match[2]!.trim() })
    logicalLine = ''
  }

  if (logicalLine) throw new Error(`Unterminated Dockerfile instruction: ${logicalLine}`)
  return instructions
}

const parseShellStatements = (source: string): string[] => {
  const statements: string[] = []
  let logicalLine = ''

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim()
    if (!logicalLine && (!trimmed || (trimmed.startsWith('#') && trimmed !== '#!/bin/sh'))) continue
    if (!logicalLine && /^\s/.test(physicalLine)) {
      throw new Error(`Indented shell statement: ${physicalLine}`)
    }

    logicalLine += `${logicalLine ? ' ' : ''}${trimmed.replace(/\\$/, '').trimEnd()}`
    if (trimmed.endsWith('\\')) continue

    statements.push(logicalLine)
    logicalLine = ''
  }

  if (logicalLine) throw new Error(`Unterminated shell statement: ${logicalLine}`)
  return statements
}

describe('Railway CLI output parsing', () => {
  test('fails closed for signer modes that require out-of-band Railway provisioning', () => {
    expect(() => assertFullRailwaySignerProvisioning('private-key')).not.toThrow()
    expect(() => assertFullRailwaySignerProvisioning('keystore')).toThrow(
      'Keystore Railway deployment requires a pre-provisioned file; use DEPLOY_ONLY=true'
    )
    expect(() => assertFullRailwaySignerProvisioning('aws')).toThrow(
      'AWS KMS Railway deployment requires pre-provisioned credentials; use DEPLOY_ONLY=true'
    )
  })

  test('identifies only populated JSON arrays as deployable strategy lists', () => {
    expect(isNonEmptyJsonArray('[{"marketId":"configured"}]')).toBe(true)
    expect(isNonEmptyJsonArray('[]')).toBe(false)
    expect(isNonEmptyJsonArray('{"marketId":"configured"}')).toBe(false)
    expect(isNonEmptyJsonArray('not-json')).toBe(false)
  })

  test('parses named services from array and wrapped response shapes', () => {
    const array = JSON.stringify([{ id: 'service-id', name: 'quoter-bot' }, { id: 'nameless' }])
    const wrapped = JSON.stringify({
      services: [{ id: 'service-id', serviceName: 'quoter-bot' }]
    })
    const created = JSON.stringify({ id: 'service-id', name: 'quoter-bot' })

    expect(parseRailwayServices(array)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
    expect(parseRailwayServices(wrapped)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
    expect(parseRailwayServices(created)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
  })

  test('returns no services for malformed JSON', () => {
    expect(parseRailwayServices('not-json')).toEqual([])
  })

  test('parses only complete attached Railway volumes', () => {
    const raw = JSON.stringify({
      volumes: [
        {
          id: 'volume-id',
          isPendingDeletion: false,
          mountPath: '/state',
          serviceName: 'quoter-bot'
        },
        {
          id: 'unattached',
          isPendingDeletion: false,
          mountPath: '/legacy',
          name: 'market-making-volume',
          serviceName: null
        },
        { id: 'incomplete', mountPath: '/other', serviceName: 'quoter-bot' }
      ]
    })

    expect(parseRailwayVolumes(raw)).toEqual([
      {
        id: 'volume-id',
        isPendingDeletion: false,
        mountPath: '/state',
        serviceName: 'quoter-bot'
      }
    ])
    expect(parseRailwayVolumes('not-json')).toEqual([])
  })

  test('requires Blue references when provisioning a fresh variable-rate service', () => {
    const environment = {
      BOOTSTRAP_MARKETS: JSON.stringify([
        { marketId: 'configured', targetRate: { strategy: 'variable_rate_avg' } }
      ]),
      LADDER_MARKETS: JSON.stringify([
        {
          marketId: 'configured',
          targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
        }
      ])
    }

    expect(() => assertFreshRailwayReferenceProvisioning(environment, true)).toThrow(
      'Missing required environment variable: REFERENCE_RPC_URL'
    )
    expect(() => assertFreshRailwayReferenceProvisioning(environment, false)).not.toThrow()
    expect(() =>
      assertFreshRailwayReferenceProvisioning(
        {
          ...environment,
          REFERENCE_RPC_URL: 'https://archive.example',
          REFERENCE_MARKET_ID: '0xreference'
        },
        true
      )
    ).not.toThrow()
  })

  test('checks fresh-service references before Railway can create the service', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeGreaterThan(-1)
    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeLessThan(deploy.indexOf('railway add --service'))
  })

  test('keeps the root entrypoint immutable and strictly limits privileged startup', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    const entrypoint = readFileSync(
      new URL('../../scripts/railway-entrypoint.sh', import.meta.url),
      'utf8'
    )
    const contextSetup = deploy.indexOf('await ensureContext()')
    const fullProvisioningBranch = deploy.indexOf('if (!DEPLOY_ONLY)')
    const ensureService = deploy.indexOf('await ensureService()', fullProvisioningBranch)
    const deployOnlySource = deploy.slice(contextSetup, fullProvisioningBranch)
    const fullProvisioningRuntimeUid = deploy.indexOf(
      "await setRuntimeVariable(['RAILWAY_RUN_UID', '0'])",
      fullProvisioningBranch
    )
    const instructions = parseDockerfile(dockerfile)
    const froms = instructions
      .map((instruction, index) => ({ ...instruction, index }))
      .filter(({ keyword }) => keyword === 'FROM')
    const runtimeFrom = froms[1]!.index
    const buildStage = instructions.slice(0, runtimeFrom)
    const runtimeStage = instructions.slice(runtimeFrom + 1)
    const buildUsers = buildStage
      .map((instruction, index) => ({ ...instruction, index }))
      .filter(({ keyword }) => keyword === 'USER')
    const userNode = buildUsers[0]!.index
    const requiredNodeRuns = [
      'corepack install',
      'pnpm install --frozen-lockfile',
      'pnpm -r --if-present run build'
    ]

    expect(contextSetup).toBeGreaterThan(-1)
    expect(deployOnlySource).not.toContain('setRuntimeVariable(')
    expect(fullProvisioningRuntimeUid).toBeGreaterThan(ensureService)
    expect(fullProvisioningRuntimeUid).toBeLessThan(deploy.indexOf('await startDeployment()'))

    // Two stages: the workspace builds in `build`; the runtime stage ships only the bot's bundle.
    expect(froms.map(({ value }) => value)).toEqual([
      'node:24.14.1-slim AS build',
      'node:24.14.1-slim'
    ])

    // Build stage: every workspace install and build step runs unprivileged after USER node.
    expect(buildUsers.map(({ value }) => value)).toEqual(['node'])
    for (const command of requiredNodeRuns) {
      const runIndex = buildStage.findIndex(
        ({ keyword, value }) => keyword === 'RUN' && value === command
      )
      expect(runIndex).toBeGreaterThan(userNode)
    }

    // Runtime stage, exactly: no USER switch (the container must start as root so the entrypoint
    // can repair Railway's root-owned volume before setpriv drops privileges), setpriv and the
    // state mount as the only RUNs, and no content beyond the bot's built output and the
    // root-owned, non-writable entrypoint — the image publishes publicly, so no other bot's code,
    // workspace source, or package manager may ship.
    expect(runtimeStage).toEqual([
      { keyword: 'ENV', value: 'HOME=/home/node' },
      {
        keyword: 'RUN',
        value:
          '/usr/bin/apt-get update && /usr/bin/apt-get install -y --no-install-recommends util-linux && /usr/bin/rm -rf /var/lib/apt/lists/*'
      },
      { keyword: 'RUN', value: '/usr/bin/mkdir -p /state' },
      {
        keyword: 'COPY',
        value:
          '--from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/package.json /repo/bots/quoter-bot/package.json'
      },
      {
        keyword: 'COPY',
        value:
          '--from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/dist /repo/bots/quoter-bot/dist'
      },
      {
        keyword: 'COPY',
        value:
          '--chown=0:0 --chmod=0555 bots/quoter-bot/scripts/railway-entrypoint.sh /usr/local/sbin/railway-entrypoint.sh'
      },
      { keyword: 'WORKDIR', value: '/repo/bots/quoter-bot' },
      {
        keyword: 'CMD',
        value: '["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]'
      }
    ])
    expect(entrypoint.startsWith('#!/bin/sh\n')).toBe(true)
    expect(parseShellStatements(entrypoint)).toEqual([
      '#!/bin/sh',
      'set -eu',
      'STATE_MOUNT_PATH=/state',
      '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"',
      'exec /usr/bin/setpriv --reuid=node --regid=node --clear-groups --bounding-set=-all --no-new-privs /usr/local/bin/node dist/src/index.js "$@"'
    ])
  })

  test('reuses an existing Docker Hub commit tag when recovering latest', () => {
    const workflow = readFileSync(
      new URL('../../../../.github/workflows/publish-quoter-bot-dockerhub.yml', import.meta.url),
      'utf8'
    )
    const setupBuildx = workflow.indexOf('- name: Set up Docker Buildx')
    const login = workflow.indexOf('- name: Login to Docker Hub')
    const immutableCheck = workflow.indexOf('- name: Check immutable SHA tag')
    const push = workflow.indexOf('- name: Build and push')
    const recoverLatest = workflow.indexOf('- name: Recover latest from immutable SHA tag')

    expect(workflow).toContain('docker buildx imagetools inspect "$image"')
    expect(workflow).toContain('echo "exists=true" >> "$GITHUB_OUTPUT"')
    expect(workflow).toContain("if: ${{ steps.sha-tag.outputs.exists != 'true' }}")
    expect(workflow).toContain(
      "if: ${{ steps.sha-tag.outputs.exists == 'true' && steps.tags.outputs.move_latest == 'true' }}"
    )
    expect(workflow).toContain('echo "move_latest=true" >> "$GITHUB_OUTPUT"')
    expect(workflow).toContain('docker buildx imagetools create --tag "$latest" "$image"')
    expect(workflow).not.toContain('https://auth.docker.io/token')
    expect(setupBuildx).toBeLessThan(login)
    expect(login).toBeLessThan(immutableCheck)
    expect(immutableCheck).toBeLessThan(push)
    expect(push).toBeLessThan(recoverLatest)
  })

  test('publishes latest only after the quoter bot deploy and release succeed', () => {
    const deployWorkflow = readFileSync(
      new URL('../../../../.github/workflows/deploy-production.yml', import.meta.url),
      'utf8'
    )
    const publishWorkflow = readFileSync(
      new URL('../../../../.github/workflows/publish-quoter-bot-dockerhub.yml', import.meta.url),
      'utf8'
    )
    const imageJob = deployWorkflow.slice(
      deployWorkflow.indexOf('  Quoter-bot-image:'),
      deployWorkflow.indexOf('  Release-blue:')
    )

    expect(imageJob).toContain('needs: [Select, Quoter-bot, Release-quoter-bot]')
    expect(imageJob).toContain("if: ${{ needs.Select.outputs.quoter_bot == 'true' }}")
    // Ancestry against release tags needs full history in the checkout.
    expect(publishWorkflow).toContain('fetch-depth: 0')
    expect(publishWorkflow).toContain('- name: Gate the latest tag')
    expect(publishWorkflow).toContain("git tag -l 'quoter-bot-*'")
    expect(publishWorkflow).toContain('git merge-base --is-ancestor "$COMMIT_SHA" "$commit"')
    expect(publishWorkflow).toContain('tags: ${{ steps.tags.outputs.tags }}')
    expect(publishWorkflow).not.toContain('}}:latest')
  })

  test('creates fresh state only during authorized provisioning', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const fullProvisioningBranch = deploy.indexOf('if (!DEPLOY_ONLY)')
    const ensureService = deploy.indexOf('await ensureService()', fullProvisioningBranch)
    const serviceLink = deploy.indexOf('await linkServiceContext(service.id)')
    const runtimeUid = deploy.indexOf("await setRuntimeVariable(['RAILWAY_RUN_UID', '0'])")
    const dockerfilePath = deploy.indexOf(
      "await setRuntimeVariable(['RAILWAY_DOCKERFILE_PATH', DOCKERFILE_PATH])"
    )
    const stateHome = deploy.indexOf(
      "await setRuntimeVariable(['XDG_STATE_HOME', STATE_MOUNT_PATH])"
    )
    const stateVolume = deploy.indexOf('await ensureStateVolume()')
    const deploymentSnapshot = deploy.indexOf(
      'const previousDeployment = parseLatestRailwayDeployment'
    )

    expect(deploy).toContain('if (process.env.RAILWAY_TOKEN) return')
    expect(ensureService).toBeGreaterThan(fullProvisioningBranch)
    expect(serviceLink).toBeGreaterThan(ensureService)
    expect(runtimeUid).toBeGreaterThan(serviceLink)
    expect(dockerfilePath).toBeGreaterThan(runtimeUid)
    expect(stateHome).toBeGreaterThan(dockerfilePath)
    expect(stateVolume).toBeGreaterThan(stateHome)
    expect(stateVolume).toBeLessThan(deploymentSnapshot)
    expect(deploy).toContain('railway volume list --json')
    expect(deploy).not.toContain('railway volume list --service')
    expect(deploy).not.toContain('railway volume update')
    expect(deploy).not.toContain('railway volume attach')
    expect(deploy).toContain('railway volume add --mount-path ${STATE_MOUNT_PATH} --json')
  })

  test('synchronizes every optional variable with explicit safe defaults', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        REQUEST_TIMEOUT_MS: '25000'
      })
    )

    expect(variables).toEqual({
      BETTERSTACK_HEARTBEAT_URL: ' ',
      BETTERSTACK_INGESTING_HOST: ' ',
      BETTERSTACK_SOURCE_TOKEN: ' ',
      REFERENCE_MARKET_ID: ' ',
      REFERENCE_RPC_URL: ' ',
      REQUEST_TIMEOUT_MS: '25000',
      TRANSACTION_RECEIPT_TIMEOUT_MS: '180000',
      V0_OFFER_GROUP_IDS: ' '
    })
  })

  test('trims optional reference configuration before uploading it to Railway', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        REFERENCE_RPC_URL: ' https://archive.example/ ',
        REFERENCE_MARKET_ID: ' 0xreference '
      })
    )

    expect(variables.REFERENCE_RPC_URL).toBe('https://archive.example/')
    expect(variables.REFERENCE_MARKET_ID).toBe('0xreference')
  })

  test('preserves Railway reference variables when a workflow uses a variable rate', () => {
    for (const targetRate of [undefined, { strategy: 'variable_rate_avg' }]) {
      const variables = Object.fromEntries(
        synchronizedOptionalRailwayVariables({
          BOOTSTRAP_MARKETS: JSON.stringify([{ marketId: 'configured', targetRate }]),
          LADDER_MARKETS: JSON.stringify([
            {
              marketId: 'configured',
              targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
            }
          ])
        })
      )

      expect(variables).not.toHaveProperty('REFERENCE_RPC_URL')
      expect(variables).not.toHaveProperty('REFERENCE_MARKET_ID')
    }
  })

  test('allows Compose deployments to omit inactive reference configuration', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

    expect(compose).toContain('      REFERENCE_RPC_URL:\n')
    expect(compose).toContain('      REFERENCE_MARKET_ID:\n')
    expect(compose).not.toContain('REFERENCE_RPC_URL: ${REFERENCE_RPC_URL:-}')
    expect(compose).not.toContain('REFERENCE_MARKET_ID: ${REFERENCE_MARKET_ID:-}')
  })

  test('reads the newest complete deployment and rejects incomplete output', () => {
    const raw = JSON.stringify({
      deployments: [
        { id: 'new', status: 'DEPLOYING' },
        { id: 'old', status: 'SUCCESS' }
      ]
    })

    expect(parseLatestRailwayDeployment(raw)).toEqual({ id: 'new', status: 'DEPLOYING' })
    expect(parseLatestRailwayDeployment('[{"status":"SUCCESS"}]')).toBeUndefined()
    expect(parseLatestRailwayDeployment('not-json')).toBeUndefined()
  })

  test('does not mistake the previous successful deployment for the new upload', () => {
    const previous = JSON.stringify([{ id: 'existing', status: 'SUCCESS' }])
    const current = JSON.stringify([{ id: 'created', status: 'BUILDING' }])

    expect(selectNewRailwayDeployment(previous, 'existing')).toBeUndefined()
    expect(selectNewRailwayDeployment(current, 'existing')).toEqual({
      id: 'created',
      status: 'BUILDING'
    })
  })

  test('recognizes only handled terminal Railway statuses', () => {
    expect(isTerminalRailwayDeploymentStatus('SUCCESS')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('CRASHED')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('NEEDS_APPROVAL')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('DEPLOYING')).toBe(false)
    expect(isTerminalRailwayDeploymentStatus('UNKNOWN')).toBe(false)
  })
})
