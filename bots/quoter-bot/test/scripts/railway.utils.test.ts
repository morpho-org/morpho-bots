import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const assertRegularFileSource = (path: URL): void => {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Railway entrypoint source must be a regular non-symlink file')
  }
}

const parseDockerParserDirectives = (source: string): string[] => {
  const directives: string[] = []

  for (const rawLine of source.split('\n')) {
    const physicalLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!/^#\s*[A-Za-z][A-Za-z0-9-]*\s*=/.test(physicalLine)) break
    directives.push(physicalLine)
  }

  return directives
}

const parseDockerfile = (source: string): DockerInstruction[] => {
  const instructions: DockerInstruction[] = []
  let logicalLine = ''

  for (const rawLine of source.split('\n')) {
    const physicalLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const trimmed = physicalLine.trim()
    if (!trimmed) {
      if (logicalLine) throw new Error('Empty Dockerfile continuation line')
      continue
    }
    if (trimmed.startsWith('#')) continue

    const continued = physicalLine.endsWith('\\')
    const fragment = (continued ? physicalLine.slice(0, -1) : physicalLine).trim()
    logicalLine += `${logicalLine ? ' ' : ''}${fragment}`
    if (continued) continue

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

  for (const rawLine of source.split('\n')) {
    const physicalLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const trimmed = physicalLine.trim()
    const standaloneComment = trimmed.startsWith('#') && trimmed !== '#!/bin/sh'
    if (!trimmed || standaloneComment) {
      if (logicalLine) {
        statements.push(logicalLine)
        logicalLine = ''
      }
      continue
    }
    if (!logicalLine && /^\s/.test(physicalLine)) {
      throw new Error(`Indented shell statement: ${physicalLine}`)
    }

    const continued = physicalLine.endsWith('\\')
    const fragment = (continued ? physicalLine.slice(0, -1) : physicalLine).trim()
    logicalLine += `${logicalLine ? ' ' : ''}${fragment}`
    if (continued) continue

    statements.push(logicalLine)
    logicalLine = ''
  }

  if (logicalLine) throw new Error(`Unterminated shell statement: ${logicalLine}`)
  return statements
}

const expectedDockerInstructions: DockerInstruction[] = [
  { keyword: 'FROM', value: 'node:24.14.1-slim' },
  { keyword: 'ENV', value: 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0' },
  { keyword: 'ENV', value: 'HOME=/home/node' },
  {
    keyword: 'RUN',
    value:
      '/usr/bin/apt-get update && /usr/bin/apt-get install -y --no-install-recommends util-linux && /usr/bin/rm -rf /var/lib/apt/lists/*'
  },
  { keyword: 'RUN', value: '/usr/local/bin/corepack enable pnpm' },
  { keyword: 'RUN', value: '/usr/bin/mkdir -p /repo /state && /usr/bin/chown node:node /repo' },
  { keyword: 'USER', value: 'node' },
  { keyword: 'WORKDIR', value: '/repo' },
  {
    keyword: 'COPY',
    value: '--chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./'
  },
  { keyword: 'RUN', value: 'corepack install' },
  { keyword: 'COPY', value: '--chown=node:node packages ./packages' },
  { keyword: 'COPY', value: '--chown=node:node bots ./bots' },
  { keyword: 'RUN', value: 'pnpm install --frozen-lockfile' },
  { keyword: 'RUN', value: 'pnpm -r --if-present run build' },
  { keyword: 'USER', value: 'root' },
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
]

const expectedEntrypointStatements = [
  '#!/bin/sh',
  'set -eu',
  'STATE_MOUNT_PATH=/state',
  '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"',
  'exec /usr/bin/setpriv --reuid=node --regid=node --clear-groups --bounding-set=-all --no-new-privs /usr/local/bin/node dist/src/index.js "$@"'
]

const assertExactSequence = <T>(actual: T[], expected: T[], subject: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${subject} does not match the security-reviewed instruction sequence`)
  }
}

const assertSecureRailwayDockerfile = (source: string): void => {
  assertExactSequence(
    parseDockerParserDirectives(source),
    ['# syntax=docker/dockerfile:1'],
    'Docker parser directives'
  )
  assertExactSequence(parseDockerfile(source), expectedDockerInstructions, 'Dockerfile')
}

const assertSecureRailwayEntrypoint = (source: string): void => {
  if (!source.startsWith('#!/bin/sh\n')) {
    throw new Error('Railway entrypoint shebang must start at byte zero')
  }
  assertExactSequence(
    parseShellStatements(source),
    expectedEntrypointStatements,
    'Railway entrypoint'
  )
}

const railwayDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const railwayEntrypointPath = new URL('../../scripts/railway-entrypoint.sh', import.meta.url)
assertRegularFileSource(railwayEntrypointPath)
const railwayEntrypoint = readFileSync(railwayEntrypointPath, 'utf8')

describe('Railway security guard hardening', () => {
  test('accepts the committed secure Dockerfile and entrypoint', () => {
    expect(() => assertSecureRailwayDockerfile(railwayDockerfile)).not.toThrow()
    expect(() => assertSecureRailwayEntrypoint(railwayEntrypoint)).not.toThrow()
  })

  test.each([
    [
      'a second stage after USER node',
      railwayDockerfile.replace('WORKDIR /repo', 'FROM node:24.14.1-slim\nWORKDIR /repo')
    ],
    [
      'a root Node command before USER node',
      railwayDockerfile.replace('USER node', 'RUN /usr/local/bin/node --version\nUSER node')
    ],
    [
      'an extra USER instruction',
      railwayDockerfile.replace('RUN corepack install', 'USER daemon\nRUN corepack install')
    ],
    [
      'an extra RUN after returning to root',
      railwayDockerfile.replace(
        'USER root',
        'USER root\nRUN /usr/local/bin/node -e "process.exit(0)"'
      )
    ],
    [
      'an extra COPY instruction',
      railwayDockerfile.replace('USER root', 'COPY package.json /tmp/package.json\nUSER root')
    ]
  ])('rejects %s', (_description, source) => {
    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test('rejects a Dockerfile pseudo-continuation with spaces after the backslash', () => {
    const source = railwayDockerfile.replace(
      '/usr/bin/apt-get update \\\n',
      '/usr/bin/apt-get update \\  \n'
    )

    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test.each([
    [
      'an alternate escape parser directive',
      railwayDockerfile.replace('# syntax=docker/dockerfile:1', '# escape=`')
    ],
    [
      'an extra parser directive',
      railwayDockerfile.replace(
        '# syntax=docker/dockerfile:1',
        '# syntax=docker/dockerfile:1\n# check=skip=JSONArgsRecommended'
      )
    ],
    [
      'duplicate syntax parser directives',
      railwayDockerfile.replace(
        '# syntax=docker/dockerfile:1',
        '# syntax=docker/dockerfile:1\n# syntax=docker/dockerfile:1'
      )
    ],
    [
      'reordered parser directives',
      railwayDockerfile.replace(
        '# syntax=docker/dockerfile:1',
        '# check=skip=JSONArgsRecommended\n# syntax=docker/dockerfile:1'
      )
    ],
    [
      'altered syntax parser directive',
      railwayDockerfile.replace('# syntax=docker/dockerfile:1', '# syntax = docker/dockerfile:1')
    ]
  ])('rejects %s', (_description, source) => {
    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test.each([
    ['a blank byte before the shebang', `\n${railwayEntrypoint}`],
    ['a comment before the shebang', `# prelude\n${railwayEntrypoint}`],
    [
      'an extra command before privilege drop',
      railwayEntrypoint.replace(
        '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"',
        '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"\n/usr/bin/id'
      )
    ],
    [
      'an early Node command',
      railwayEntrypoint.replace(
        '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"',
        '/usr/local/bin/node --version\n/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"'
      )
    ]
  ])('rejects %s', (_description, source) => {
    expect(() => assertSecureRailwayEntrypoint(source)).toThrow()
  })

  test('rejects a shell pseudo-continuation with spaces after the backslash', () => {
    const source = railwayEntrypoint.replace(
      'exec /usr/bin/setpriv \\\n',
      'exec /usr/bin/setpriv \\ \n'
    )

    expect(() => assertSecureRailwayEntrypoint(source)).toThrow()
  })

  test('allows standalone comments inside a valid Docker continuation', () => {
    const source = railwayDockerfile.replace(
      '/usr/bin/apt-get update \\\n',
      '/usr/bin/apt-get update \\\n  # package setup\n'
    )

    expect(() => assertSecureRailwayDockerfile(source)).not.toThrow()
  })

  test('rejects a blank line inside a Docker continuation', () => {
    const source = railwayDockerfile.replace(
      '/usr/bin/apt-get update \\\n',
      '/usr/bin/apt-get update \\\n\n'
    )

    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test('requires the committed entrypoint source path to be a regular non-symlink file', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'railway-entrypoint-source-'))
    const target = join(fixture, 'entrypoint-target.sh')
    const link = join(fixture, 'railway-entrypoint.sh')

    try {
      writeFileSync(target, '#!/bin/sh\n')
      symlinkSync(target, link)
      expect(() => assertRegularFileSource(new URL(`file://${link}`))).toThrow()
    } finally {
      rmSync(fixture, { force: true, recursive: true })
    }
  })

  test('rejects standalone comments and blanks that terminate a shell continuation', () => {
    const source = railwayEntrypoint.replace(
      'exec /usr/bin/setpriv \\\n',
      'exec /usr/bin/setpriv \\\n  # privilege arguments\n\n'
    )

    expect(() => assertSecureRailwayEntrypoint(source)).toThrow()
  })

  test('rejects a different initial image', () => {
    const source = railwayDockerfile.replace('FROM node:24.14.1-slim', 'FROM node:latest')

    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test('rejects changes to the trusted root prefix', () => {
    const source = railwayDockerfile.replace(
      'RUN /usr/local/bin/corepack enable pnpm',
      'RUN /usr/local/bin/corepack enable pnpm && /usr/local/bin/node --version'
    )

    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test('rejects a non-absolute entrypoint command', () => {
    const source = railwayDockerfile.replace(
      '["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]',
      '["railway-entrypoint.sh", "start", "--verbose"]'
    )

    expect(() => assertSecureRailwayDockerfile(source)).toThrow()
  })

  test('rejects reordered privilege-drop arguments', () => {
    const source = railwayEntrypoint.replace(
      '  --reuid=node \\\n  --regid=node \\\n',
      '  --regid=node \\\n  --reuid=node \\\n'
    )

    expect(() => assertSecureRailwayEntrypoint(source)).toThrow()
  })
})

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

  test('parses complete attached and detached Railway volumes', () => {
    const raw = JSON.stringify({
      volumes: [
        {
          id: 'volume-id',
          isPendingDeletion: false,
          mountPath: '/state',
          name: 'quoter-bot-volume',
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
        name: 'quoter-bot-volume',
        serviceName: 'quoter-bot'
      },
      {
        id: 'unattached',
        isPendingDeletion: false,
        mountPath: '/legacy',
        name: 'market-making-volume',
        serviceName: undefined
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

  test('migrates detached legacy state only during authorized provisioning', () => {
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
    expect(deploy).toContain("const LEGACY_STATE_VOLUME_NAME = 'market-making-volume'")
    expect(deploy).toContain("const LEGACY_STATE_VOLUME_MOUNT_PATH = '/state/morpho-quoter-bot'")
    expect(deploy).toContain('railway volume list --json')
    expect(deploy).not.toContain('railway volume list --service')
    expect(deploy).toContain(
      'railway volume update --volume ${volume.id} --mount-path ${LEGACY_STATE_VOLUME_MOUNT_PATH} --json'
    )
    expect(deploy).toContain('railway volume attach --volume ${volume.id} --yes --json')
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
