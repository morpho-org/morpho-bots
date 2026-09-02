/**
 * Reproducible, idempotent deployment of the multi-chain midnight-liquidation system to the Railway
 * project `bot.liquidation.midnight`: one `bot-<chainId>` runner per chain (see CHAINS below).
 * Borrower candidates come from the markets liquidation-candidates API
 * (LIQUIDATION_CANDIDATES_API_URL, public by default), so there is no indexer or database to
 * provision.
 *
 * Runs anywhere with the `railway` CLI installed and authenticated. The target project is supplied
 * entirely via env vars — no project identifier is baked into this (open-source) file:
 *   - RAILWAY_PROJECT_ID (required) selects the project; RAILWAY_ENVIRONMENT defaults to `production`.
 *   - CI / unattended: set RAILWAY_TOKEN (a project token scoped to that project / environment) —
 *     every command is then implicitly scoped to it.
 *   - Local: an interactive `railway login` session; the script links the project by id.
 *
 * Per-chain env vars are chainId-suffixed (endpoints, keys, and fee calibration differ per chain);
 * the names set INSIDE each container stay unsuffixed, because each service runs exactly one chain:
 *   - RPC_URL_<chainId>                 (required per chain) — reads, simulate, sends
 *   - RPC_URL_FALLBACK_<chainId>        (optional) — the signer's failover transport
 *   - LIQUIDATOR_PRIVATE_KEY_<chainId>  (per chain) OR a shared LIQUIDATOR_PRIVATE_KEY fallback
 *   - ZEROX_API_KEY[_<chainId>] / ONEINCH_API_KEY[_<chainId>] / LIFI_API_KEY[_<chainId>]
 *     (optional; a key ENABLES its venue — LiFi also via ENABLE_LIFI[_<chainId>]=true, keyless)
 *   - ALLOW_BAD_DEBT_ONLY[_<chainId>]=true — required for a chain with NO venue enabled; the bot
 *     fails loud at startup otherwise.
 *   - MAX_FEE_GWEI[_<chainId>] / PRIORITY_FEE_GWEI[_<chainId>]
 *     (optional) — override the chain's built-in tuning row from src/config.ts.
 *
 *   RAILWAY_PROJECT_ID=… RPC_URL_8453=… RPC_URL_1=… LIQUIDATOR_PRIVATE_KEY=0x… \
 *     pnpm --filter @morpho-org/midnight-liquidation run deploy:railway
 *
 * The build context MUST be the repo root so the pnpm workspace (packages/*) resolves — the script
 * runs `railway up` with cwd set to the repo root (mirrors the Dockerfile header + compose context),
 * and passes `-p/-e` explicitly so the deploy targets this project/environment regardless of whatever
 * the repo-root directory happens to be linked to (a sibling bot's deploy leaves it linked elsewhere).
 *
 * Idempotent: existing services / variables are reused; each run redeploys every bot. The venue
 * posture is SYNCHRONIZED on every full run: ENABLE_LIFI / ALLOW_BAD_DEBT_ONLY are set explicitly, and
 * each venue key and fee override is either set from this run's inputs or deleted when absent — so
 * neither a stale opt-in nor a dropped key can linger from a previous run. Cutover: the
 * pre-multichain `bot` service is removed once its replacement `bot-8453` is confirmed healthy
 * (leaving it would run a second, stale Base liquidator with a funded key).
 *
 * Secret hygiene: secrets (per-chain RPC_URL, LIQUIDATOR_PRIVATE_KEY, aggregator keys) are piped to
 * `railway variable set --stdin` so their values never appear in argv; on failure we surface only
 * the variable key, never its value; variable values are never logged.
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

// Delete a service if it exists (used to retire the pre-multichain `bot` service after cutover). A
// failure is a warning, not fatal — the deploy already succeeded; surface it so an operator removes
// the stale service manually. `--yes` skips the confirmation prompt (non-TTY safe).
async function removeService(name: string): Promise<void> {
  if (!(await listServices()).some(service => service.name === name)) return
  console.log(`Removing legacy service ${name}…`)
  const { error } = await tryCatch(
    $`railway service delete --service ${name} --environment ${ENVIRONMENT} --yes --json`
  )
  if (error)
    console.warn(
      `Could not remove legacy service ${name}: ${stderrOf(error)}\n` +
        `  Remove it manually — otherwise it runs a second, stale Base liquidator with a funded key.`
    )
  else console.log(`Removed legacy service ${name}.`)
}

// Non-secret variable. `kv` is a single "KEY=VALUE" arg; only the key is logged.
async function setVar(service: string, kv: string): Promise<void> {
  const key = kv.split('=')[0]
  const { error } = await tryCatch($`railway variable set ${kv} -s ${service} --skip-deploys`)
  if (error) throw new Error(`Failed to set ${key} on ${service}: ${stderrOf(error)}`)
  console.log(`Set ${key} on ${service}.`)
}

// Keys currently set on a service — used to clear stale secrets without blind deletes. The CLI's JSON
// includes raw values, so it is parsed in-memory and only key NAMES ever leave here.
async function listVarKeys(service: string): Promise<Set<string>> {
  const { data, error } = await tryCatch(
    $`railway variable list -s ${service} -e ${ENVIRONMENT} -p ${PROJECT_ID} --json`.then(
      r => r.stdout
    )
  )
  if (error || typeof data !== 'string') return new Set()
  const { data: parsed } = tryCatch(() => JSON.parse(data) as unknown)
  return isRecord(parsed) ? new Set(Object.keys(parsed)) : new Set()
}

// Delete a variable (used to clear a stale venue secret or tunable). Fatal on failure: a stale key
// that survives the delete silently keeps its venue enabled, which is exactly the drift this prevents.
async function deleteVar(service: string, key: string): Promise<void> {
  const { error } = await tryCatch($`railway variable delete ${key} -s ${service} --skip-deploys`)
  if (error) throw new Error(`Failed to delete ${key} on ${service}: ${stderrOf(error)}`)
  console.log(`Deleted ${key} on ${service} (stale).`)
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
  // `railway up` runs with cwd = REPO_ROOT (build context), but the script only ever links the
  // *package* dir (ensureContext, which is where pnpm runs it). Railway links are per-directory, so
  // without explicit flags `up` would inherit whatever REPO_ROOT happens to be linked to — e.g. a
  // sibling bot's project after its last deploy, which fails with "No environment specified" or, worse,
  // targets the wrong project. Scope the deploy explicitly so it never depends on ambient link state.
  const { error } = await tryCatch(
    $({ cwd: REPO_ROOT })`railway up -s ${service} -p ${PROJECT_ID} -e ${ENVIRONMENT} -d`
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

// CRASHED is a failure: the bot fails loud at startup on a bad config (no venues without the
// bad-debt-only opt-in, malformed URLs, a fee pair with no bump headroom), so a crash-looping service
// must never read as a green deploy.
const badStatus = (status: string) =>
  status === 'FAILED' || status === 'TIMEOUT' || status === 'CRASHED'

// The chains this deploy targets: one `bot-<chainId>` service each. Add a chain here AND in
// src/config.ts's CHAIN_MAP (with its tuning row) to extend coverage.
type ChainDeploy = { chainId: number; service: string }
const CHAINS: ChainDeploy[] = [
  { chainId: 8453, service: serviceName('bot-8453') },
  { chainId: 1, service: serviceName('bot-1') }
]
// The pre-multichain single-chain service name, retired after `bot-8453` is confirmed healthy.
const LEGACY_BOT_SERVICE = 'bot'

// Deploy-only mode (DEPLOY_ONLY=1|true): re-ship the ALREADY-PROVISIONED services from the checked-out
// tree and set NOTHING — no secrets, no variables. This is the path CI uses: the per-stage GitHub
// Environment holds only RAILWAY_TOKEN + RAILWAY_PROJECT_ID, and the services/secrets were provisioned
// once by a full (secret-bearing) run of this script. Skips the RPC/key/venue requirements the full
// path enforces, so it never needs those secrets in CI. Runs before `chainSecrets` is read.
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

// Read a chainId-suffixed env var (e.g. RPC_URL_8453). Endpoints and keys differ per chain, so the
// operator-facing names are suffixed; the names set INSIDE each container stay unsuffixed, because
// each service runs exactly one chain.
function suffixed(name: string, chainId: number): string | undefined {
  return process.env[`${name}_${chainId}`]?.trim() || undefined
}
function requiredSuffixed(name: string, chainId: number): string {
  const value = suffixed(name, chainId)
  if (!value) throw new Error(`Missing required env var: ${name}_${chainId}`)
  return value
}
// A chainId-suffixed boolean flag with an unsuffixed fallback (e.g. ALLOW_BAD_DEBT_ONLY_1).
function suffixedFlag(name: string, chainId: number): boolean {
  const raw = suffixed(name, chainId) ?? process.env[name]?.trim()
  return /^(1|true)$/i.test(raw ?? '')
}

// Per-chain secrets/config, read + validated up front so we fail loud before mutating Railway state.
// The venue posture mirrors the bot's own startup gate: a chain with no enabled venue is refused
// unless its bad-debt-only opt-in is set, so a misconfigured full run can't provision a service that
// will only crash-loop.
const chainSecrets = CHAINS.map(chain => {
  const rpcUrl = requiredSuffixed('RPC_URL', chain.chainId)
  // A single funded key may be reused across chains (unsuffixed fallback), or set one per chain.
  const liquidatorPrivateKey =
    suffixed('LIQUIDATOR_PRIVATE_KEY', chain.chainId) ?? process.env.LIQUIDATOR_PRIVATE_KEY?.trim()
  if (!liquidatorPrivateKey)
    throw new Error(
      `Missing required env var: LIQUIDATOR_PRIVATE_KEY_${chain.chainId} (or a shared LIQUIDATOR_PRIVATE_KEY)`
    )
  assertPrivateKey(liquidatorPrivateKey)
  const zeroxApiKey = suffixed('ZEROX_API_KEY', chain.chainId) ?? process.env.ZEROX_API_KEY?.trim()
  const oneInchApiKey =
    suffixed('ONEINCH_API_KEY', chain.chainId) ?? process.env.ONEINCH_API_KEY?.trim()
  const lifiApiKey = suffixed('LIFI_API_KEY', chain.chainId) ?? process.env.LIFI_API_KEY?.trim()
  const enableLifi = suffixedFlag('ENABLE_LIFI', chain.chainId) || Boolean(lifiApiKey)
  const allowBadDebtOnly = suffixedFlag('ALLOW_BAD_DEBT_ONLY', chain.chainId)
  const hasVenue = Boolean(zeroxApiKey || oneInchApiKey || enableLifi)
  if (!hasVenue && !allowBadDebtOnly) {
    throw new Error(
      `Chain ${chain.chainId} has no venue enabled (set ZEROX_API_KEY/ONEINCH_API_KEY/LIFI_API_KEY` +
        `[_${chain.chainId}] or ENABLE_LIFI[_${chain.chainId}]=true) and no ` +
        `ALLOW_BAD_DEBT_ONLY[_${chain.chainId}]=true opt-in.`
    )
  }
  return {
    ...chain,
    rpcUrl,
    // Optional failover endpoint. The bot reads RPC_URL_FALLBACK for the signer's transport, but
    // nothing has ever pushed it, so the failover path was dead in every deployment until now.
    rpcUrlFallback: suffixed('RPC_URL_FALLBACK', chain.chainId),
    liquidatorPrivateKey,
    zeroxApiKey,
    oneInchApiKey,
    lifiApiKey,
    enableLifi,
    allowBadDebtOnly,
    // Fee and economics knobs default from the chain's tuning row in src/config.ts. Pushed only when
    // the operator sets them, so an unset var leaves the in-code per-chain default in force.
    maxFeeGwei: suffixed('MAX_FEE_GWEI', chain.chainId),
    priorityFeeGwei: suffixed('PRIORITY_FEE_GWEI', chain.chainId),
    betterstackHeartbeatUrl: suffixed('BETTERSTACK_HEARTBEAT_URL', chain.chainId)
  }
})

await ensureContext()

// Optional BetterStack log shipping, one source for midnight-liq shared across its chains (told apart
// by the bot/chainId fields the logger stamps). Host is a plain var; token is a secret. Off when unset
// — the bot's in-process loglayer transport stays inert, so the container behaves exactly as before.
const betterstackHost = process.env.BETTERSTACK_INGESTING_HOST?.trim()
const betterstackToken = process.env.BETTERSTACK_SOURCE_TOKEN?.trim()

// --- bot-<chainId>: one liquidation runner per chain. Borrower discovery polls the markets
// liquidation-candidates API and the whitelist comes from the Midnight markets API (both public by
// default), so there is nothing else to provision. The in-container var names stay RPC_URL /
// LIQUIDATOR_PRIVATE_KEY (the chainId suffix is only an operator-side convention). The whole venue
// posture is SYNCHRONIZED every full run — ENABLE_LIFI and ALLOW_BAD_DEBT_ONLY set explicitly (true or
// false), and each venue key either set from this run's inputs or DELETED when absent: Railway vars
// persist across runs, so a lingering opt-in or a stale key from a past run would otherwise silently
// defeat the bot's fail-loud gate / keep a dropped venue enabled.
for (const chain of chainSecrets) {
  await ensureService(chain.service)
  await setVar(chain.service, `CHAIN_ID=${chain.chainId}`)
  await setVar(chain.service, `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
  await setVar(chain.service, 'LOG_LEVEL=info')
  await setVar(chain.service, `ENABLE_LIFI=${chain.enableLifi}`)
  await setVar(chain.service, `ALLOW_BAD_DEBT_ONLY=${chain.allowBadDebtOnly}`)
  await setSecret(chain.service, 'RPC_URL', chain.rpcUrl)
  await setSecret(chain.service, 'LIQUIDATOR_PRIVATE_KEY', chain.liquidatorPrivateKey)
  const existingKeys = await listVarKeys(chain.service)
  if (chain.rpcUrlFallback) {
    await setSecret(chain.service, 'RPC_URL_FALLBACK', chain.rpcUrlFallback)
  } else if (existingKeys.has('RPC_URL_FALLBACK')) {
    await deleteVar(chain.service, 'RPC_URL_FALLBACK')
  }
  const venueKeys: [string, string | undefined][] = [
    ['ZEROX_API_KEY', chain.zeroxApiKey],
    ['ONEINCH_API_KEY', chain.oneInchApiKey],
    ['LIFI_API_KEY', chain.lifiApiKey]
  ]
  for (const [key, value] of venueKeys) {
    if (value) await setSecret(chain.service, key, value)
    else if (existingKeys.has(key)) await deleteVar(chain.service, key)
  }
  // Fee / economics overrides are plain vars (not secrets) and are synchronized the same way, so
  // dropping one from a run restores the chain's in-code default instead of leaving a stale value.
  const tunables: [string, string | undefined][] = [
    ['MAX_FEE_GWEI', chain.maxFeeGwei],
    ['PRIORITY_FEE_GWEI', chain.priorityFeeGwei]
  ]
  for (const [key, value] of tunables) {
    if (value) await setVar(chain.service, `${key}=${value}`)
    else if (existingKeys.has(key)) await deleteVar(chain.service, key)
  }
  if (betterstackHost) await setVar(chain.service, `BETTERSTACK_INGESTING_HOST=${betterstackHost}`)
  if (betterstackToken) await setSecret(chain.service, 'BETTERSTACK_SOURCE_TOKEN', betterstackToken)
  if (chain.betterstackHeartbeatUrl) {
    await setSecret(chain.service, 'BETTERSTACK_HEARTBEAT_URL', chain.betterstackHeartbeatUrl)
  }
  await deployService(chain.service)
}

const botStatuses = new Map<string, string>()
for (const chain of chainSecrets) botStatuses.set(chain.service, await waitForDeploy(chain.service))

// Cutover: retire the pre-multichain `bot` service ONLY once its replacement `bot-8453` is healthy, so
// the Base liquidator is never left without a running instance. Leaving `bot` up would run a second,
// stale Base liquidator with the same funded key alongside bot-8453 (nonce contention/double-submits).
const baseService = CHAINS.find(chain => chain.chainId === 8453)?.service
if (ENVIRONMENT === 'production' && baseService && botStatuses.get(baseService) === 'SUCCESS') {
  await removeService(LEGACY_BOT_SERVICE)
} else if (ENVIRONMENT === 'production') {
  console.warn(
    `Skipping '${LEGACY_BOT_SERVICE}' removal — bot-8453 not confirmed SUCCESS. Remove it manually ` +
      `once bot-8453 is healthy to avoid a stale second Base liquidator.`
  )
}

console.log('')
console.log('=== Deployment status ===')
for (const [service, status] of botStatuses) console.log(`  ${service}: ${status}`)
console.log('')
console.log('=== Manual steps ===')
console.log('  1. Each bot needs a funded key + a real RPC before it can broadcast. Mainnet also')
console.log('     needs the Executor deployed (pnpm --filter @repo/contracts run deploy:executor).')
console.log('  2. Venue keys enable venues (ZEROX_API_KEY / ONEINCH_API_KEY / LIFI_API_KEY, or')
console.log(
  '     ENABLE_LIFI=true keyless). A bad-debt-only chain discovers positions and realizes'
)
console.log('     pure bad debt but never swap-liquidates — rerun with venue inputs to arm it.')
console.log('  3. Mainnet markets are fail-closed until listed: the bot idles at markets: 0 rather')
console.log('     than erroring, so provisioning ahead of listing is safe.')

process.exitCode = [...botStatuses.values()].some(badStatus) ? 1 : 0
