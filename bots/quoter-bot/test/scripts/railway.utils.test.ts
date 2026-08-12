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
        { id: 'unattached', isPendingDeletion: false, mountPath: '/other', serviceName: null },
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
    const users = instructions
      .map((instruction, index) => ({ ...instruction, index }))
      .filter(({ keyword }) => keyword === 'USER')
    const userNode = users[0]!.index
    const userRoot = users[1]!.index
    const requiredNodeRuns = [
      'corepack install',
      'pnpm install --frozen-lockfile',
      'pnpm -r --if-present run build'
    ]

    expect(contextSetup).toBeGreaterThan(-1)
    expect(deployOnlySource).not.toContain('setRuntimeVariable(')
    expect(fullProvisioningRuntimeUid).toBeGreaterThan(ensureService)
    expect(fullProvisioningRuntimeUid).toBeLessThan(deploy.indexOf('await startDeployment()'))
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends util-linux')
    expect(dockerfile).toContain('ENV HOME=/home/node')
    expect(users.map(({ value }) => value)).toEqual(['node', 'root'])
    for (const command of requiredNodeRuns) {
      const runIndex = instructions.findIndex(
        ({ keyword, value }) => keyword === 'RUN' && value === command
      )
      expect(runIndex).toBeGreaterThan(userNode)
      expect(runIndex).toBeLessThan(userRoot)
    }
    expect(instructions.slice(userRoot + 1)).toEqual([
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

    expect(compose).toContain('REFERENCE_RPC_URL: ${REFERENCE_RPC_URL:-}')
    expect(compose).toContain('REFERENCE_MARKET_ID: ${REFERENCE_MARKET_ID:-}')
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
