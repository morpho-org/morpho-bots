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
 *     pnpm --filter @morpho-org/midnight-liquidation run deploy:railway
 *
 * The build context MUST be the repo root so the pnpm workspace (packages/*) resolves — the script
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
import { $ } from 'execa'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The target project is env-driven so no project identifier is baked into this (open-source) file.
// RAILWAY_PROJECT_ID is required; RAILWAY_ENVIRONMENT defaults to the conventional `production`.
const PROJECT_ID = required(process.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DOCKERFILE_PATH = 'bots/midnight-liquidation/Dockerfile'
// Repo root is three levels up from this file (scripts → midnight-liquidation → bots → repo root).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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
// reason — plan limits, auth, selection prompts — to stderr). execa's error carries `.stderr` as a
// string; fall back to the generic message. Safe for non-secret commands; never used on setSecret.
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
  const { error } = await tryCatch($`railway --version`)
  if (error)
    throw new Error('Railway CLI not found. Install it: https://docs.railway.com/guides/cli')
}

// `railway add` has no --project/--environment flag, so it acts on the linked context. A project
// token scopes every command implicitly; otherwise we link the project id once for this run.
async function ensureContext(): Promise<void> {
  if (process.env.RAILWAY_TOKEN) {
    console.log('Using RAILWAY_TOKEN for project context.')
    return
  }
  const { error } = await tryCatch($`railway link -p ${PROJECT_ID} -e ${ENVIRONMENT}`)
  if (error) {
    throw new Error(
      `Failed to link ${PROJECT_ID} (${ENVIRONMENT}). Set RAILWAY_TOKEN or run \`railway login\`.`
    )
  }
  console.log(`Linked project ${PROJECT_ID} (${ENVIRONMENT}).`)
}

async function listServices(): Promise<RailwayService[]> {
  const { data, error } = await tryCatch($`railway service list --json`.then(r => r.stdout))
  return error || typeof data !== 'string' ? [] : parseServices(data)
}

async function ensureService(name: string): Promise<void> {
  if ((await listServices()).some(service => service.name === name)) {
    console.log(`Service ${name} already exists.`)
    return
  }
  console.log(`Creating service ${name}…`)
  const { error } = await tryCatch($`railway add --service ${name} --json`)
  if (error) throw new Error(`Failed to create service ${name}: ${stderrOf(error)}`)
}

// Non-secret variable. `kv` is a single "KEY=VALUE" arg; only the key is logged.
async function setVar(service: string, kv: string): Promise<void> {
  const key = kv.split('=')[0]
  const { error } = await tryCatch($`railway variable set ${kv} -s ${service} --skip-deploys`)
  if (error) throw new Error(`Failed to set ${key} on ${service}: ${stderrOf(error)}`)
  console.log(`Set ${key} on ${service}.`)
}

// Secret variable: value piped via stdin (never argv), `--json` omitted (it echoes raw values).
async function setSecret(service: string, key: string, value: string): Promise<void> {
  const { error } = await tryCatch(
    Promise.resolve(
      $({ input: value })`railway variable set ${key} --stdin -s ${service} --skip-deploys`
    )
  )
  if (error) throw new Error(`Failed to set ${key} on ${service}`)
  console.log(`Set ${key} on ${service} (secret).`)
}

async function deployService(service: string): Promise<void> {
  console.log(`Deploying ${service} from repo root…`)
  // `railway up` runs with cwd = REPO_ROOT (build context), but the script only ever links the
  // *package* dir (ensureContext, which is where pnpm runs it). Railway links are per-directory, so
  // without explicit flags `up` would inherit whatever REPO_ROOT happens to be linked to — e.g. a
  // sibling bot's project after its last deploy, which fails with "No environment specified" or, worse,
  // targets the wrong project. Scope the deploy explicitly so it never depends on ambient link state.
  const { error } = await tryCatch(
    Promise.resolve(
      $({ cwd: REPO_ROOT })`railway up -s ${service} -p ${PROJECT_ID} -e ${ENVIRONMENT} -d`
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
  const { data, error } = await tryCatch($(args[0] ?? 'railway', args.slice(1)).then(r => r.stdout))
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

const BOT_SERVICE = serviceName('bot')

// Deploy-only mode (DEPLOY_ONLY=1|true): re-ship the ALREADY-PROVISIONED `bot` service from the
// checked-out tree and set NOTHING — no secrets, no variables. This is the path CI uses: the per-
// stage GitHub Environment holds only RAILWAY_TOKEN + RAILWAY_PROJECT_ID, and the service/secrets
// were provisioned once by a full (secret-bearing) run of this script. Skips the RPC/key/venue
// requirements the full path enforces, so it never needs those secrets in CI.
if (/^(1|true)$/i.test(process.env.DEPLOY_ONLY?.trim() ?? '')) {
  await ensureContext()
  await deployService(BOT_SERVICE) // `railway up` rebuilds it server-side
  const status = await waitForDeploy(BOT_SERVICE)
  console.log('')
  console.log('=== Deploy-only status ===')
  console.log(`  ${BOT_SERVICE}: ${status}`)
  process.exit(status === 'FAILED' || status === 'TIMEOUT' ? 1 : 0)
}

// Secrets / config from this process's env (fail loud before mutating any Railway state).
const rpcUrl = required(process.env, 'RPC_URL')
const liquidatorPrivateKey = required(process.env, 'LIQUIDATOR_PRIVATE_KEY')
assertPrivateKey(liquidatorPrivateKey)

// Venues are enabled by the presence of their API key. The bot hard-fails at boot with no key unless
// ALLOW_BAD_DEBT_ONLY=true — so require the operator to pass a venue key (pushed as a secret) or
// explicitly opt into bad-debt-only here, rather than deploying a service that crash-loops.
const zeroxKey = process.env.ZEROX_API_KEY?.trim()
const oneinchKey = process.env.ONEINCH_API_KEY?.trim()
const lifiKey = process.env.LIFI_API_KEY?.trim()
const allowBadDebtOnly = process.env.ALLOW_BAD_DEBT_ONLY?.trim().toLowerCase() === 'true'
if (!zeroxKey && !oneinchKey && !lifiKey && !allowBadDebtOnly) {
  throw new Error(
    'Set LIFI_API_KEY, ZEROX_API_KEY, and/or ONEINCH_API_KEY, or ALLOW_BAD_DEBT_ONLY=true to deploy bad-debt-only.'
  )
}

// Optional BetterStack log shipping: host is a plain var, token is a secret. Off when unset — the
// bot's in-process loglayer transport stays inert, so the container behaves exactly as before.
const betterstackHost = process.env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = process.env.BETTERSTACK_SOURCE_TOKEN?.trim()
const betterstackHeartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL?.trim()

await ensureContext()

// --- bot: the liquidation runner. Borrower discovery polls the markets liquidation-candidates API
// and the markets whitelist comes from the Midnight markets API (both public by default), so there is
// nothing else to provision — no swap-config file/volume anymore.
await ensureService(BOT_SERVICE)
await setVar(BOT_SERVICE, 'CHAIN_ID=8453')
await setVar(BOT_SERVICE, `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
await setVar(BOT_SERVICE, 'LOG_LEVEL=info')
await setSecret(BOT_SERVICE, 'RPC_URL', rpcUrl)
await setSecret(BOT_SERVICE, 'LIQUIDATOR_PRIVATE_KEY', liquidatorPrivateKey)
if (zeroxKey) await setSecret(BOT_SERVICE, 'ZEROX_API_KEY', zeroxKey)
if (oneinchKey) await setSecret(BOT_SERVICE, 'ONEINCH_API_KEY', oneinchKey)
if (lifiKey) await setSecret(BOT_SERVICE, 'LIFI_API_KEY', lifiKey)
if (allowBadDebtOnly) await setVar(BOT_SERVICE, 'ALLOW_BAD_DEBT_ONLY=true')
if (betterstackHost) await setVar(BOT_SERVICE, `BETTERSTACK_INGESTING_HOST=${betterstackHost}`)
if (betterstackToken) await setSecret(BOT_SERVICE, 'BETTERSTACK_SOURCE_TOKEN', betterstackToken)
if (betterstackHeartbeatUrl) {
  await setSecret(BOT_SERVICE, 'BETTERSTACK_HEARTBEAT_URL', betterstackHeartbeatUrl)
}
await deployService(BOT_SERVICE)

const botStatus = await waitForDeploy(BOT_SERVICE)

console.log('')
console.log('=== Deployment status ===')
console.log(`  ${BOT_SERVICE}: ${botStatus}`)
console.log('')
console.log('=== Manual steps ===')
console.log('  1. The bot needs a funded liquidator key + a real RPC before it can broadcast.')
if (!zeroxKey && !oneinchKey && !lifiKey) {
  console.log(
    '  2. Deployed in bad-debt-only mode (no venue key). Add LIFI_API_KEY, ZEROX_API_KEY,'
  )
  console.log(
    '     and/or ONEINCH_API_KEY and drop ALLOW_BAD_DEBT_ONLY to enable swap-liquidations.'
  )
}

// FAILED/TIMEOUT signal a real build or platform problem; a bot CRASH pre-config is expected.
process.exitCode = botStatus === 'FAILED' || botStatus === 'TIMEOUT' ? 1 : 0
