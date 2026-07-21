/**
 * Reproducible, idempotent deployment of the monitor bot to Railway.
 *
 * Runs anywhere with the `railway` CLI installed and authenticated. The target project is supplied
 * entirely via env vars — no project identifier is baked into this (open-source) file:
 *   - RAILWAY_PROJECT_ID (required) selects the project; RAILWAY_ENVIRONMENT defaults to `production`.
 *   - CI / unattended: set RAILWAY_TOKEN (a project token scoped to that project / environment) —
 *     every command is then implicitly scoped to it.
 *   - Local: an interactive `railway login` session; the script links the project by id.
 *
 *   RAILWAY_PROJECT_ID=… bun run --filter @morpho-org/monitor-bot deploy:railway
 *
 * The build context MUST be the repo root so the bun workspace (packages/*) resolves — the script
 * runs `railway up` with cwd set to the repo root (mirrors the Dockerfile header + compose context),
 * and passes `-p/-e` explicitly so the deploy targets this project/environment regardless of whatever
 * the repo-root directory happens to be linked to (a sibling bot's deploy leaves it linked elsewhere).
 *
 * Idempotent: existing services / variables are reused; each run redeploys the service.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

const PROJECT_ID = required(Bun.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DOCKERFILE_PATH = 'bots/monitor-bot/Dockerfile'
// Repo root is three levels up from this file (scripts → monitor-bot → bots → repo root).
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

type Env = Record<string, string | undefined>
type RailwayService = { id: string; name: string }

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

// Railway service names are project-wide, while environments only scope service instances. Retain
// the established production name and prefix every non-production service to prevent collisions.
function serviceName(productionName: string): string {
  return ENVIRONMENT === 'production' ? productionName : `${ENVIRONMENT}-${productionName}`
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
  // sibling bot's project after its last deploy, which fails with "No environment specified" or,
  // worse, targets the wrong project. Scope the deploy explicitly so it never depends on ambient
  // link state.
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway up -s ${service} -p ${PROJECT_ID} -e ${ENVIRONMENT} -d`.cwd(REPO_ROOT).quiet()
    )
  )
  if (error) throw new Error(`Failed to start deploy for ${service}: ${stderrOf(error)}`)
}

async function latestStatus(service: string): Promise<string> {
  // -e/-p explicit for the same reason as deployService: don't depend on ambient link state.
  const args = [
    'railway',
    'deployment',
    'list',
    '-s',
    service,
    '-e',
    ENVIRONMENT,
    '-p',
    PROJECT_ID,
    '--limit',
    '1',
    '--json'
  ]
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

// Unlike midnight-liquidation (where a pre-config CRASH is expected before secrets exist), every
// monitor-bot variable has a default — a CRASHED boot is always a real failure and must never
// read as a green deploy.
function badStatus(status: string): boolean {
  return status === 'FAILED' || status === 'CRASHED' || status === 'TIMEOUT'
}

await assertCli()

const BOT_SERVICE = serviceName('bot')

// Deploy-only mode (DEPLOY_ONLY=1|true): re-ship the ALREADY-PROVISIONED `bot` service from the
// checked-out tree and set NOTHING — no secrets, no variables. This is the path CI uses: the per-
// stage GitHub Environment holds only RAILWAY_TOKEN + RAILWAY_PROJECT_ID, and the service was
// provisioned once by a full run of this script.
if (/^(1|true)$/i.test(Bun.env.DEPLOY_ONLY?.trim() ?? '')) {
  await ensureContext()
  await deployService(BOT_SERVICE) // `railway up` rebuilds it server-side
  const status = await waitForDeploy(BOT_SERVICE)
  console.log('')
  console.log('=== Deploy-only status ===')
  console.log(`  ${BOT_SERVICE}: ${status}`)
  process.exit(badStatus(status) ? 1 : 0)
}

// Slack config: the channel id is a plain var, the bot token a secret. Both-or-neither — the bot
// fails loud at boot on a half-configured pair, so enforce it here before touching Railway state.
const slackChannel = Bun.env.SLACK_CHANNEL?.trim()
const slackToken = Bun.env.SLACK_BOT_TOKEN?.trim()
if (Boolean(slackChannel) !== Boolean(slackToken)) {
  throw new Error('Set both SLACK_CHANNEL and SLACK_BOT_TOKEN, or neither (log-only alerts).')
}

// Optional BetterStack log shipping: host is a plain var, token is a secret. Off when unset — the
// bot's in-process loglayer transport stays inert, so the container behaves exactly as before.
const betterstackHost = Bun.env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = Bun.env.BETTERSTACK_SOURCE_TOKEN?.trim()
const betterstackHeartbeatUrl = Bun.env.BETTERSTACK_HEARTBEAT_URL?.trim()

// Optional core-API auth (sent as `x-api-key`, read at point of use by the bot). Off when unset —
// token metadata enrichment falls back and the bot runs as before.
const morphoApiKey = Bun.env.MORPHO_API_KEY?.trim()

// Optional wallet-CRM CSV path (a plain, non-secret path on the mounted volume, e.g.
// /data/wallets.csv). Off when unset — the wallet store stays empty and lookups are no-ops. WARNING:
// the bot reads this file at boot and fails loud if it is missing, so only set it once the volume is
// mounted AND the CSV has been uploaded to it (the file is PII and is uploaded out-of-band via
// `railway volume files upload`, never shipped in the build context). See the bot README.
const walletsCsvPath = Bun.env.WALLETS_CSV_PATH?.trim()

await ensureContext()

await ensureService(BOT_SERVICE)
await setVar(BOT_SERVICE, `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
await setVar(BOT_SERVICE, 'LOG_LEVEL=info')
if (slackChannel && slackToken) {
  await setVar(BOT_SERVICE, `SLACK_CHANNEL=${slackChannel}`)
  await setSecret(BOT_SERVICE, 'SLACK_BOT_TOKEN', slackToken)
}
if (betterstackHost) await setVar(BOT_SERVICE, `BETTERSTACK_INGESTING_HOST=${betterstackHost}`)
if (betterstackToken) await setSecret(BOT_SERVICE, 'BETTERSTACK_SOURCE_TOKEN', betterstackToken)
if (betterstackHeartbeatUrl) {
  await setSecret(BOT_SERVICE, 'BETTERSTACK_HEARTBEAT_URL', betterstackHeartbeatUrl)
}
if (morphoApiKey) await setSecret(BOT_SERVICE, 'MORPHO_API_KEY', morphoApiKey)
if (walletsCsvPath) await setVar(BOT_SERVICE, `WALLETS_CSV_PATH=${walletsCsvPath}`)
await deployService(BOT_SERVICE)

const botStatus = await waitForDeploy(BOT_SERVICE)

console.log('')
console.log('=== Deployment status ===')
console.log(`  ${BOT_SERVICE}: ${botStatus}`)

process.exitCode = badStatus(botStatus) ? 1 : 0
