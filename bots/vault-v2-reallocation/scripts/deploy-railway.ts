/**
 * Reproducible, idempotent deployment of the multi-chain vault-v2-reallocation system to a Railway
 * project: one `bot-<chainId>` runner per chain (see CHAINS below). All data comes over RPC, so
 * there is no Postgres or indexer service to provision.
 *
 * Runs anywhere with the `railway` CLI installed and authenticated. The target project is supplied
 * entirely via env vars — no project identifier is baked into this (open-source) file:
 *   - RAILWAY_PROJECT_ID (required) selects the project; RAILWAY_ENVIRONMENT defaults to `production`.
 *   - CI / unattended: set RAILWAY_TOKEN (a project token scoped to that project / environment).
 *   - Local: an interactive `railway login` session; the script links the project by id.
 *
 * Per-chain env vars are chainId-suffixed (endpoints/whitelists differ per chain):
 *   - RPC_URL_<chainId>              (required per chain)
 *   - VAULT_WHITELIST_<chainId>      (required per chain) — comma-separated VaultV2 vaults
 *   - REALLOCATOR_PRIVATE_KEY_<chainId> (per chain) OR a shared REALLOCATOR_PRIVATE_KEY fallback;
 *     the EOA must hold the allocator role on every whitelisted vault
 *   - STRATEGY_<chainId>             (optional; defaults to equalize-utilizations)
 *   - DRY_RUN_<chainId>              (optional; defaults to true — flip to false once the logged
 *     reallocation.dry_run plans look right)
 *   - BETTERSTACK_HEARTBEAT_URL_<chainId> (optional)
 *
 *   RAILWAY_PROJECT_ID=… RPC_URL_1=… VAULT_WHITELIST_1=0x… REALLOCATOR_PRIVATE_KEY=0x… \
 *     pnpm --filter @morpho-org/vault-v2-reallocation run deploy:railway
 *
 * The build context MUST be the repo root so the pnpm workspace (packages/*) resolves — the script
 * runs `railway up` with cwd set to the repo root (mirrors the Dockerfile header + compose context).
 *
 * Idempotent: existing services / variables are reused; each run redeploys every bot and
 * re-synchronizes STRATEGY / DRY_RUN / VAULT_WHITELIST from this run's inputs.
 *
 * Secret hygiene: secrets (per-chain RPC_URL, REALLOCATOR_PRIVATE_KEY) are piped to
 * `railway variable set --stdin` so their values never appear in argv; on failure we surface only
 * the variable key, never its value; variable values are never logged.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'execa'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ID = required(process.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DOCKERFILE_PATH = 'bots/vault-v2-reallocation/Dockerfile'
// Repo root is three levels up from this file (scripts → vault-v2-reallocation → bots → repo root).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

type Env = Record<string, string | undefined>
type RailwayService = { id: string; name: string }

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

// Railway service names are project-wide, while environments only scope service instances. Retain
// the established production names and prefix every non-production service to prevent collisions.
function serviceName(productionName: string): string {
  return ENVIRONMENT === 'production'
    ? productionName
    : `${ENVIRONMENT}-${productionName.toLowerCase()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Narrow an unknown JSON field to a string (CLI JSON fields we read are all strings); never coerces
// objects (which would stringify to '[object Object]').
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Surface a failed `railway` command's stderr so failures are actionable. Safe for non-secret
// commands; never used on setSecret.
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
    throw new Error('REALLOCATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
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
    $({ input: value })`railway variable set ${key} --stdin -s ${service} --skip-deploys`
  )
  if (error) throw new Error(`Failed to set ${key} on ${service}`)
  console.log(`Set ${key} on ${service} (secret).`)
}

async function deployService(service: string): Promise<void> {
  console.log(`Deploying ${service} from repo root…`)
  // Pass -p/-e explicitly: `railway link` doesn't reliably carry the environment into this non-TTY
  // subprocess, so `railway up` otherwise errors "No environment specified".
  const { error } = await tryCatch(
    $({ cwd: REPO_ROOT })`railway up -s ${service} -e ${ENVIRONMENT} -p ${PROJECT_ID} -d`
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

// CRASHED is a failure: the bot fails loud at startup on a bad config (empty whitelist, a
// whitelisted address that isn't a MetaMorpho vault), so a crash-looping service must never read
// as a green deploy.
const badStatus = (status: string) =>
  status === 'FAILED' || status === 'TIMEOUT' || status === 'CRASHED'

await assertCli()

// The chains this deploy targets: one `bot-<chainId>` service each. Add a chain here + in
// src/config.ts's chain map to extend coverage.
type ChainDeploy = { chainId: number; service: string }
const CHAINS: ChainDeploy[] = [
  { chainId: 1, service: serviceName('bot-1') },
  { chainId: 8453, service: serviceName('bot-8453') }
]

// Deploy-only mode (DEPLOY_ONLY=1|true): re-ship the ALREADY-PROVISIONED services from the
// checked-out tree and set NOTHING — no secrets, no variables. This is the path CI uses: the
// per-bot-per-stage GitHub Environment holds only RAILWAY_TOKEN + RAILWAY_PROJECT_ID, and the
// services/secrets were provisioned once by a full (secret-bearing) run of this script.
if (/^(1|true)$/i.test(process.env.DEPLOY_ONLY?.trim() ?? '')) {
  await ensureContext()
  const services = CHAINS.map(chain => chain.service)
  for (const service of services) await deployService(service)
  const statuses = new Map<string, string>()
  for (const service of services) statuses.set(service, await waitForDeploy(service))
  console.log('')
  console.log('=== Deploy-only status ===')
  for (const [service, status] of statuses) console.log(`  ${service}: ${status}`)
  process.exit([...statuses.values()].some(badStatus) ? 1 : 0)
}

// Read a chainId-suffixed env var (e.g. RPC_URL_1). Endpoints and whitelists differ per chain so
// these are required per chain; the private key may instead fall back to a shared unsuffixed key.
function suffixed(name: string, chainId: number): string | undefined {
  return process.env[`${name}_${chainId}`]?.trim() || undefined
}
function requiredSuffixed(name: string, chainId: number): string {
  const value = suffixed(name, chainId)
  if (!value) throw new Error(`Missing required env var: ${name}_${chainId}`)
  return value
}

// Per-chain secrets/config, read + validated up front so we fail loud before mutating Railway state.
const chainSecrets = CHAINS.map(chain => {
  const rpcUrl = requiredSuffixed('RPC_URL', chain.chainId)
  const vaultWhitelist = requiredSuffixed('VAULT_WHITELIST', chain.chainId)
  // A single allocator key may be reused across chains (unsuffixed fallback), or set one per chain.
  const reallocatorPrivateKey =
    suffixed('REALLOCATOR_PRIVATE_KEY', chain.chainId) ??
    process.env.REALLOCATOR_PRIVATE_KEY?.trim()
  if (!reallocatorPrivateKey)
    throw new Error(
      `Missing required env var: REALLOCATOR_PRIVATE_KEY_${chain.chainId} (or a shared REALLOCATOR_PRIVATE_KEY)`
    )
  assertPrivateKey(reallocatorPrivateKey)
  const strategy = suffixed('STRATEGY', chain.chainId) ?? 'equalize-utilizations'
  // New deployments default to dry-run; flip DRY_RUN_<chainId>=false once the plans look right.
  const dryRun = !/^(0|false)$/i.test(suffixed('DRY_RUN', chain.chainId) ?? '')
  const betterstackHeartbeatUrl = suffixed('BETTERSTACK_HEARTBEAT_URL', chain.chainId)
  return {
    ...chain,
    rpcUrl,
    vaultWhitelist,
    reallocatorPrivateKey,
    strategy,
    dryRun,
    betterstackHeartbeatUrl
  }
})

await ensureContext()

// Optional BetterStack log shipping, one source shared across this bot's chains (told apart by the
// bot/chainId fields the logger stamps). Host is a plain var; token is a secret. Off when unset.
const betterstackHost = process.env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = process.env.BETTERSTACK_SOURCE_TOKEN?.trim()

// --- bot-<chainId>: one reallocation runner per chain. The in-container var names stay RPC_URL /
// REALLOCATOR_PRIVATE_KEY / VAULT_WHITELIST (the chainId suffix is only an operator-side convention).
for (const chain of chainSecrets) {
  await ensureService(chain.service)
  await setVar(chain.service, `CHAIN_ID=${chain.chainId}`)
  await setVar(chain.service, `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
  await setVar(chain.service, 'LOG_LEVEL=info')
  await setVar(chain.service, `VAULT_WHITELIST=${chain.vaultWhitelist}`)
  await setVar(chain.service, `STRATEGY=${chain.strategy}`)
  await setVar(chain.service, `DRY_RUN=${chain.dryRun}`)
  await setSecret(chain.service, 'RPC_URL', chain.rpcUrl)
  await setSecret(chain.service, 'REALLOCATOR_PRIVATE_KEY', chain.reallocatorPrivateKey)
  if (betterstackHost) await setVar(chain.service, `BETTERSTACK_INGESTING_HOST=${betterstackHost}`)
  if (betterstackToken) await setSecret(chain.service, 'BETTERSTACK_SOURCE_TOKEN', betterstackToken)
  if (chain.betterstackHeartbeatUrl) {
    await setSecret(chain.service, 'BETTERSTACK_HEARTBEAT_URL', chain.betterstackHeartbeatUrl)
  }
  await deployService(chain.service)
}

const botStatuses = new Map<string, string>()
for (const chain of chainSecrets) botStatuses.set(chain.service, await waitForDeploy(chain.service))

console.log('')
console.log('=== Deployment status ===')
for (const [service, status] of botStatuses) console.log(`  ${service}: ${status}`)
console.log('')
console.log('=== Manual steps ===')
console.log('  1. Grant the allocator role to the EOA on every whitelisted vault (the bot logs')
console.log('     allocator.missing_role and skips a vault until the grant lands).')
console.log('  2. New services start in DRY_RUN=true: review the reallocation.dry_run plans in the')
console.log('     logs, then rerun with DRY_RUN_<chainId>=false to arm the bot.')

process.exitCode = [...botStatuses.values()].some(badStatus) ? 1 : 0
