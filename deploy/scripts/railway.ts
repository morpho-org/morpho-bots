import { delay, tryCatch } from '@repo/utils'
import { $ } from 'bun'

type Env = Record<string, string | undefined>
type RailwayService = { id: string; name: string }
type VolumeMount = { serviceName: string; mountPath: string }

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'CRASHED'])

export function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export function assertPrivateKey(key: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
}

export function signerPolicy(chainId: number, executor: string): string {
  return JSON.stringify({
    chainId,
    executor,
    maxFeePerGasWei: '300000000000',
    maxGasLimit: '15000000',
    maxDataBytes: 65536
  })
}

export function deploymentFailed(status: string): boolean {
  return status === 'FAILED' || status === 'CRASHED' || status === 'TIMEOUT'
}

type Target = { service: string; projectId: string; environment: string; hasToken: boolean }

// A project-scoped RAILWAY_TOKEN already pins the project + environment; passing -p/-e alongside it
// conflicts, so omit them when a token is present and let the token supply the context.
function targetFlags(projectId: string, environment: string, hasToken: boolean): string[] {
  return hasToken ? [] : ['-p', projectId, '-e', environment]
}

export function upArgs({ service, projectId, environment, hasToken }: Target): string[] {
  return ['railway', 'up', '-s', service, ...targetFlags(projectId, environment, hasToken), '-d']
}

export function deploymentListArgs({
  service,
  projectId,
  environment,
  hasToken
}: Target): string[] {
  const target = targetFlags(projectId, environment, hasToken)
  return ['railway', 'deployment', 'list', '-s', service, ...target, '--limit', '1', '--json']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function rows(raw: string, key: string): Record<string, unknown>[] {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const values = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data[key])
      ? data[key]
      : []
  return values.filter(isRecord)
}

function parseServices(raw: string): RailwayService[] {
  return rows(raw, 'services')
    .map(row => ({ id: str(row.id), name: str(row.name) || str(row.serviceName) }))
    .filter(service => service.name)
}

function parseVolumeMounts(raw: string): VolumeMount[] {
  return rows(raw, 'volumes')
    .map(row => ({
      serviceName: str(row.serviceName) || str(row.service_name),
      mountPath: str(row.mountPath) || str(row.mount_path)
    }))
    .filter(mount => mount.mountPath)
}

function parseLatestStatus(raw: string): string {
  const latest = rows(raw, 'deployments')[0]
  return latest ? str(latest.status) || 'UNKNOWN' : 'UNKNOWN'
}

function stderrOf(error: unknown): string {
  if (isRecord(error) && 'stderr' in error) {
    const stderr = error.stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
    if (stderr instanceof Uint8Array) {
      const text = Buffer.from(stderr).toString('utf8').trim()
      if (text) return text
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export class Railway {
  private readonly hasToken: boolean

  constructor(
    private readonly projectId: string,
    private readonly environment: string,
    private readonly repoRoot: string
  ) {
    this.hasToken = Boolean(Bun.env.RAILWAY_TOKEN?.trim())
  }

  async initialize(): Promise<void> {
    const cli = await tryCatch(Promise.resolve($`railway --version`.quiet()))
    if (cli.error) {
      throw new Error('Railway CLI not found. Install it: https://docs.railway.com/guides/cli')
    }
    if (this.hasToken) {
      console.log('Using RAILWAY_TOKEN for project context.')
      return
    }
    const { error } = await tryCatch(
      Promise.resolve($`railway link -p ${this.projectId} -e ${this.environment}`.quiet())
    )
    if (error) {
      throw new Error(
        `Failed to link ${this.projectId} (${this.environment}). Set RAILWAY_TOKEN or run \`railway login\`.`
      )
    }
    console.log(`Linked project ${this.projectId} (${this.environment}).`)
  }

  private async services(): Promise<RailwayService[]> {
    const { data, error } = await tryCatch(
      Promise.resolve($`railway service list --json`.quiet().text())
    )
    return error || typeof data !== 'string' ? [] : parseServices(data)
  }

  async ensurePostgres(): Promise<string> {
    const findPostgres = (services: RailwayService[]) =>
      services.find(service => /postgres/i.test(service.name))
    let postgres = findPostgres(await this.services())
    if (!postgres) {
      console.log('Adding managed Postgres…')
      const { error } = await tryCatch(
        Promise.resolve($`railway add --database postgres --json`.quiet())
      )
      postgres = findPostgres(await this.services())
      if (!postgres && error) throw new Error(`Failed to add Postgres: ${stderrOf(error)}`)
    }
    if (!postgres) {
      throw new Error('Postgres service not found after `railway add --database postgres`.')
    }
    console.log(`Postgres service: ${postgres.name}`)
    return postgres.name
  }

  async ensureService(name: string): Promise<void> {
    if ((await this.services()).some(service => service.name === name)) {
      console.log(`Service ${name} already exists.`)
      return
    }
    console.log(`Creating service ${name}…`)
    const { error } = await tryCatch(
      Promise.resolve($`railway add --service ${name} --json`.quiet())
    )
    if (error) throw new Error(`Failed to create service ${name}: ${stderrOf(error)}`)
  }

  async ensureVolume(service: string, mountPath: string): Promise<void> {
    const { data } = await tryCatch(Promise.resolve($`railway volume list --json`.quiet().text()))
    const mounts = typeof data === 'string' ? parseVolumeMounts(data) : []
    if (mounts.some(mount => mount.serviceName === service && mount.mountPath === mountPath)) {
      console.log(`Volume at ${mountPath} already on ${service}.`)
      return
    }
    const link = await tryCatch(
      Promise.resolve(
        $`railway link -p ${this.projectId} -e ${this.environment} -s ${service}`.quiet()
      )
    )
    if (link.error) {
      throw new Error(`Failed to link ${service} for volume add: ${stderrOf(link.error)}`)
    }
    const { error } = await tryCatch(
      Promise.resolve($`railway volume add -m ${mountPath} --json`.quiet())
    )
    if (error) {
      // Idempotent: a volume synced/forked in from another environment (or a prior run) may already
      // occupy this mount. `railway volume list --json` output varies across CLI versions so the
      // detection above can miss it — treat an "already mounted" add as success, not a failure.
      const detail = stderrOf(error)
      if (/already (mounted|exists)/i.test(detail)) {
        console.log(`Volume at ${mountPath} already on ${service}.`)
        return
      }
      throw new Error(`Failed to add volume ${mountPath} to ${service}: ${detail}`)
    }
    console.log(`Added volume at ${mountPath} to ${service}.`)
  }

  async setVariables(service: string, variables: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(variables)) {
      const assignment = `${key}=${value}`
      const { error } = await tryCatch(
        Promise.resolve($`railway variable set ${assignment} -s ${service} --skip-deploys`.quiet())
      )
      if (error) throw new Error(`Failed to set ${key} on ${service}: ${stderrOf(error)}`)
      console.log(`Set ${key} on ${service}.`)
    }
  }

  async setSecrets(service: string, secrets: Record<string, string | undefined>): Promise<void> {
    for (const [key, value] of Object.entries(secrets)) {
      if (!value) continue
      const { error } = await tryCatch(
        Promise.resolve(
          $`railway variable set ${key} --stdin -s ${service} --skip-deploys < ${Buffer.from(value, 'utf8')}`.quiet()
        )
      )
      if (error) throw new Error(`Failed to set ${key} on ${service}`)
      console.log(`Set ${key} on ${service} (secret).`)
    }
  }

  private target(service: string): Target {
    return {
      service,
      projectId: this.projectId,
      environment: this.environment,
      hasToken: this.hasToken
    }
  }

  async deploy(service: string): Promise<void> {
    console.log(`Deploying ${service} from repo root…`)
    const args = upArgs(this.target(service))
    const { error } = await tryCatch(Promise.resolve($`${args}`.cwd(this.repoRoot).quiet()))
    if (error) throw new Error(`Failed to start deploy for ${service}: ${stderrOf(error)}`)
  }

  private async latestStatus(service: string): Promise<string> {
    const args = deploymentListArgs(this.target(service))
    const { data, error } = await tryCatch(Promise.resolve($`${args}`.quiet().text()))
    return error || typeof data !== 'string' ? 'UNKNOWN' : parseLatestStatus(data)
  }

  async waitForDeploy(service: string, maxAttempts = 60, intervalMs = 10_000): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const status = await this.latestStatus(service)
      if (TERMINAL_STATUSES.has(status)) return status
      console.log(`[${service}] ${status} (${attempt}/${maxAttempts})…`)
      await delay(intervalMs)
    }
    return 'TIMEOUT'
  }
}
