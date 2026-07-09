/**
 * Reproducible, idempotent deployment of the midnight-liquidation bot to the Railway project
 * `bot.liquidation.midnight`. Borrower candidates come from the markets liquidation-candidates API
 * (LIQUIDATION_CANDIDATES_API_URL, public by default), so the bot runs as a single service — no
 * indexer or database to provision.
 *
 * Runs anywhere with the `railway` CLI installed and authenticated. The target project is supplied
 * entirely via env vars — no project identifier is baked into this (open-source) file:
 *   - RAILWAY_PROJECT_ID (required) selects the project; RAILWAY_ENVIRONMENT defaults to `production`.
 *   - CI / unattended: set RAILWAY_TOKEN (a project token scoped to that project / environment) —
 *     every command is then implicitly scoped to it.
 *   - Local: an interactive `railway login` session; the script links the project by id.
 *
 *   RAILWAY_PROJECT_ID=… RPC_URL=… LIQUIDATOR_PRIVATE_KEY=0x… \
 *     bun run --filter @morpho-org/midnight-liquidation deploy:railway
 *
 * The build context MUST be the repo root so the bun workspace (packages/*) resolves — the script
 * runs `railway up` with cwd set to the repo root (mirrors the Dockerfile header + compose context),
 * and passes `-p/-e` explicitly so the deploy targets this project/environment regardless of whatever
 * the repo-root directory happens to be linked to (a sibling bot's deploy leaves it linked elsewhere).
 *
 * Idempotent: existing services / volume / variables are reused; each run redeploys both services.
 *
 * Secret hygiene: secrets (RPC_URL, LIQUIDATOR_PRIVATE_KEY) are piped to `railway variable set
 * --stdin` so their values never appear in argv; on failure we surface only the variable key, never
 * its value; variable values are never logged.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

// The target project is env-driven so no project identifier is baked into this (open-source) file.
// RAILWAY_PROJECT_ID is required; RAILWAY_ENVIRONMENT defaults to the conventional `production`.
const PROJECT_ID = required(Bun.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DOCKERFILE_PATH = 'bots/midnight-liquidation/Dockerfile'
const SWAP_MOUNT_PATH = '/config'
const SWAP_CONFIG_PATH = '/config/swap.json'
// Repo root is three levels up from this file (scripts → midnight-liquidation → bots → repo root).
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

type Env = Record<string, string | undefined>
type RailwayService = { id: string; name: string }

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Narrow an unknown JSON field to a string (CLI JSON fields we read are all strings); never coerces
// objects (which would stringify to '[object Object]').
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Surface a failed `railway` command's stderr so failures are actionable (the CLI writes the real
// reason — plan limits, auth, selection prompts — to stderr). Bun's ShellError carries `.stderr` as
// bytes; fall back to the generic message. Safe for non-secret commands; never used on setSecret.
function stderrOf(error: unknown): string {
  if (isRecord(error) && 'stderr' in error) {
    const s = (error as { stderr: unknown }).stderr
    if (typeof s === 'string' && s.trim()) return s.trim()
    if (s instanceof Uint8Array) {
      const text = Buffer.from(s).toString('utf8').trim()
      if (text) return text
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function assertPrivateKey(key: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('LIQUIDATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
}

function parseServices(raw: string): RailwayService[] {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.services)
      ? data.services
      : []
  return rows
    .filter(isRecord)
    .map(row => ({ id: str(row.id), name: str(row.name) || str(row.serviceName) }))
    .filter(service => service.name)
}

function parseVolumeMountPaths(raw: string): string[] {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.volumes)
      ? data.volumes
      : []
  return rows
    .filter(isRecord)
    .map(row => str(row.mountPath) || str(row.mount_path))
    .filter(Boolean)
}

function parseLatestStatus(raw: string): string {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.deployments)
      ? data.deployments
      : []
  const latest = rows.filter(isRecord)[0]
  return latest ? str(latest.status) || 'UNKNOWN' : 'UNKNOWN'
}

async function assertCli(): Promise<void> {
  const { error } = await tryCatch(Promise.resolve($`railway --version`.quiet()))
  if (error)
    throw new Error('Railway CLI not found. Install it: https://docs.railway.com/guides/cli')
}

// `railway add` has no --project/--environment flag, so it acts on the linked context. A project
// token scopes every command implicitly; otherwise we link the project id once for this run.
async function ensureContext(): Promise<void> {
  if (Bun.env.RAILWAY_TOKEN) {
    console.log('Using RAILWAY_TOKEN for project context.')
    return
  }
  const { error } = await tryCatch(
    Promise.resolve($`railway link -p ${PROJECT_ID} -e ${ENVIRONMENT}`.quiet())
  )
  if (error) {
    throw new Error(
      `Failed to link ${PROJECT_ID} (${ENVIRONMENT}). Set RAILWAY_TOKEN or run \`railway login\`.`
    )
  }
  console.log(`Linked project ${PROJECT_ID} (${ENVIRONMENT}).`)
}

async function listServices(): Promise<RailwayService[]> {
  const { data, error } = await tryCatch(
    Promise.resolve($`railway service list --json`.quiet().text())
  )
  return error || typeof data !== 'string' ? [] : parseServices(data)
}

async function ensureService(name: string): Promise<void> {
  if ((await listServices()).some(service => service.name === name)) {
    console.log(`Service ${name} already exists.`)
    return
  }
  console.log(`Creating service ${name}…`)
  const { error } = await tryCatch(Promise.resolve($`railway add --service ${name} --json`.quiet()))
  if (error) throw new Error(`Failed to create service ${name}: ${stderrOf(error)}`)
}

async function ensureVolume(service: string, mountPath: string): Promise<void> {
  const { data } = await tryCatch(Promise.resolve($`railway volume list --json`.quiet().text()))
  if (typeof data === 'string' && parseVolumeMountPaths(data).includes(mountPath)) {
    console.log(`Volume at ${mountPath} already exists.`)
    return
  }
  // `railway volume add` attaches to the *linked* service; its own --service flag is broken in CLI
  // 5.x (panics), so link the target service first, then add without -s.
  const link = await tryCatch(
    Promise.resolve($`railway link -p ${PROJECT_ID} -e ${ENVIRONMENT} -s ${service}`.quiet())
  )
  if (link.error)
    throw new Error(`Failed to link ${service} for volume add: ${stderrOf(link.error)}`)
  const { error } = await tryCatch(
    Promise.resolve($`railway volume add -m ${mountPath} --json`.quiet())
  )
  if (error) throw new Error(`Failed to add volume ${mountPath} to ${service}: ${stderrOf(error)}`)
  console.log(`Added volume at ${mountPath} to ${service}.`)
}

// Non-secret variable. `kv` is a single "KEY=VALUE" arg; only the key is logged.
async function setVar(service: string, kv: string): Promise<void> {
  const key = kv.split('=')[0]
  const { error } = await tryCatch(
    Promise.resolve($`railway variable set ${kv} -s ${service} --skip-deploys`.quiet())
  )
  if (error) throw new Error(`Failed to set ${key} on ${service}: ${stderrOf(error)}`)
  console.log(`Set ${key} on ${service}.`)
}

// Secret variable: value piped via stdin (never argv), `--json` omitted (it echoes raw values).
async function setSecret(service: string, key: string, value: string): Promise<void> {
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway variable set ${key} --stdin -s ${service} --skip-deploys < ${Buffer.from(value, 'utf8')}`.quiet()
    )
  )
  if (error) throw new Error(`Failed to set ${key} on ${service}`)
  console.log(`Set ${key} on ${service} (secret).`)
}

async function deployService(service: string): Promise<void> {
  console.log(`Deploying ${service} from repo root…`)
  // `railway up` runs with cwd = REPO_ROOT (build context), but the script only ever links the
  // *package* dir (ensureContext, which is where bun runs it). Railway links are per-directory, so
  // without explicit flags `up` would inherit whatever REPO_ROOT happens to be linked to — e.g. a
  // sibling bot's project after its last deploy, which fails with "No environment specified" or, worse,
  // targets the wrong project. Scope the deploy explicitly so it never depends on ambient link state.
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway up -s ${service} -p ${PROJECT_ID} -e ${ENVIRONMENT} -d`.cwd(REPO_ROOT).quiet()
    )
  )
  if (error) throw new Error(`Failed to start deploy for ${service}: ${stderrOf(error)}`)
}

async function latestStatus(service: string): Promise<string> {
  const args = ['railway', 'deployment', 'list', '-s', service, '--limit', '1', '--json']
  const { data, error } = await tryCatch(Promise.resolve($`${args}`.quiet().text()))
  return error || typeof data !== 'string' ? 'UNKNOWN' : parseLatestStatus(data)
}

// Bounded poll (default 10 min) on an awaited timer — never a foreground shell sleep, so CI can't hang.
async function waitForDeploy(
  service: string,
  maxAttempts = 60,
  intervalMs = 10_000
): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await latestStatus(service)
    if (status === 'SUCCESS' || status === 'FAILED' || status === 'CRASHED') return status
    console.log(`[${service}] ${status} (${attempt}/${maxAttempts})…`)
    await delay(intervalMs)
  }
  return 'TIMEOUT'
}

await assertCli()

// Secrets / config from this process's env (fail loud before mutating any Railway state).
const rpcUrl = required(Bun.env, 'RPC_URL')
const liquidatorPrivateKey = required(Bun.env, 'LIQUIDATOR_PRIVATE_KEY')
assertPrivateKey(liquidatorPrivateKey)

await ensureContext()

// --- bot: the liquidation runner. Borrower discovery polls the markets liquidation-candidates API
// (LIQUIDATION_CANDIDATES_API_URL defaults to the public endpoint), so there is nothing else to
// provision. Swap config lives on a volume at /config (uploaded out-of-band — see manual steps below).
await ensureService('bot')
await ensureVolume('bot', SWAP_MOUNT_PATH)
await setVar('bot', 'CHAIN_ID=8453')
await setVar('bot', `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
await setVar('bot', `SWAP_CONFIG_PATH=${SWAP_CONFIG_PATH}`)
await setVar('bot', 'LOG_LEVEL=info')
await setSecret('bot', 'RPC_URL', rpcUrl)
await setSecret('bot', 'LIQUIDATOR_PRIVATE_KEY', liquidatorPrivateKey)
await deployService('bot')

const botStatus = await waitForDeploy('bot')

console.log('')
console.log('=== Deployment status ===')
console.log(`  bot: ${botStatus}`)
console.log('')
console.log('=== Manual steps ===')
console.log(`  1. Upload swap.json into the bot's ${SWAP_MOUNT_PATH} volume to enable routed`)
console.log('     liquidations (the bot boots without it — no routes: it identifies borrowers and')
console.log('     realizes bad debt but skips routed liquidations). The volume mounts only into a')
console.log('     running container, so do this once the bot is up:')
console.log(`       railway volume files upload ./swap.config.json ${SWAP_CONFIG_PATH} --overwrite`)
console.log('     (prompts for the volume; or pass --volume <name> before the subcommand. Shape:')
console.log(
  '     bots/midnight-liquidation/README.md.) Restart the bot afterward to pick up routes.'
)
console.log('  2. The bot still needs a funded key + a real RPC before it can broadcast.')

// FAILED/TIMEOUT signal a real build or platform problem; a bot CRASH pre-config is expected.
process.exitCode = botStatus === 'FAILED' || botStatus === 'TIMEOUT' ? 1 : 0
