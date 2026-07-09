/**
 * Reproducible, idempotent deployment of the multi-chain blue-liquidation system to a Railway
 * project: managed Postgres + ONE shared `rindexer` service (indexing every chain's Borrow events
 * into one database) + one `bot-<chainId>` runner per chain (see CHAINS below). Each bot reads
 * borrower candidates from rindexer's Postgres tables (filtered to its own chain's `network`), so all
 * are provisioned here.
 *
 * Runs anywhere with the `railway` CLI installed and authenticated. The target project is supplied
 * entirely via env vars — no project identifier is baked into this (open-source) file:
 *   - RAILWAY_PROJECT_ID (required) selects the project; RAILWAY_ENVIRONMENT defaults to `production`.
 *   - CI / unattended: set RAILWAY_TOKEN (a project token scoped to that project / environment) —
 *     every command is then implicitly scoped to it.
 *   - Local: an interactive `railway login` session; the script links the project by id.
 *
 * Per-chain env vars are chainId-suffixed (endpoints/keys differ per chain):
 *   - RPC_URL_<chainId>            (required per chain) — the bot's RPC (reads, simulate, sends)
 *   - RINDEXER_RPC_URL_<chainId>   (optional; defaults to RPC_URL_<chainId>) — that network's indexer RPC
 *   - LIQUIDATOR_PRIVATE_KEY_<chainId> (per chain) OR a shared LIQUIDATOR_PRIVATE_KEY fallback
 *   - ZEROX_API_KEY[_<chainId>] / ONEINCH_API_KEY[_<chainId>] (optional; only if a collateral routes there)
 *
 *   RAILWAY_PROJECT_ID=… RPC_URL_8453=… RPC_URL_4663=… LIQUIDATOR_PRIVATE_KEY=0x… \
 *     bun run --filter @morpho-org/blue-liquidation deploy:railway
 *
 * The build context MUST be the repo root so the bun workspace (packages/*) resolves — the script
 * runs `railway up` with cwd set to the repo root (mirrors the Dockerfile header + compose context).
 *
 * Idempotent: existing services / volume / variables are reused; each run redeploys the rindexer and
 * every bot. Cutover: the pre-multichain `bot` service is removed once its replacement `bot-8453` is
 * confirmed healthy (leaving it would run a second, stale Base liquidator with a funded key).
 *
 * Secret hygiene: secrets (per-chain RPC_URL/RINDEXER_RPC_URL, LIQUIDATOR_PRIVATE_KEY, aggregator
 * keys) are piped to `railway variable set --stdin` so their values never appear in argv; on failure
 * we surface only the variable key, never its value; variable values are never logged.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

// The target project is env-driven so no project identifier is baked into this (open-source) file.
// RAILWAY_PROJECT_ID is required; RAILWAY_ENVIRONMENT defaults to the conventional `production`.
const PROJECT_ID = required(Bun.env, 'RAILWAY_PROJECT_ID')
const ENVIRONMENT = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DOCKERFILE_PATH = 'bots/blue-liquidation/Dockerfile'
const SWAP_MOUNT_PATH = '/config'
const SWAP_CONFIG_PATH = '/config/swap.json'
// Repo root is three levels up from this file (scripts → blue-liquidation → bots → repo root).
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

// Each volume carries the service it is attached to (`serviceName`, null when orphaned by a deleted
// service). We key on (serviceName, mountPath) because `railway volume list` is environment-wide:
// matching mountPath alone would treat another service's — or an orphaned — `/config` volume as this
// service's, and skip creating one. Returns [] on any parse failure (treated as "no volumes").
function parseVolumeMounts(raw: string): { serviceName: string; mountPath: string }[] {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.volumes)
      ? data.volumes
      : []
  return rows
    .filter(isRecord)
    .map(row => ({
      serviceName: str(row.serviceName) || str(row.service_name),
      mountPath: str(row.mountPath) || str(row.mount_path)
    }))
    .filter(mount => mount.mountPath)
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

async function ensurePostgres(): Promise<string> {
  const isPostgres = (service: RailwayService) => /postgres/i.test(service.name)
  let postgres = (await listServices()).find(isPostgres)
  if (!postgres) {
    console.log('Adding managed Postgres…')
    // `railway add --database` can exit non-zero even after the managed Postgres is provisioned (it
    // writes selection echoes to stderr and the service shows up moments later). Don't trust the exit
    // code alone — re-list and only treat the failure as fatal if Postgres is still absent.
    const { error } = await tryCatch(
      Promise.resolve($`railway add --database postgres --json`.quiet())
    )
    postgres = (await listServices()).find(isPostgres)
    if (!postgres && error) throw new Error(`Failed to add Postgres: ${stderrOf(error)}`)
  }
  if (!postgres)
    throw new Error('Postgres service not found after `railway add --database postgres`.')
  console.log(`Postgres service: ${postgres.name}`)
  return postgres.name
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

// Delete a service if it exists (used to retire the pre-multichain `bot` service after cutover). A
// failure is a warning, not fatal — the deploy already succeeded; surface it so an operator removes
// the stale service manually. `--yes` skips the confirmation prompt (non-TTY safe).
async function removeService(name: string): Promise<void> {
  if (!(await listServices()).some(service => service.name === name)) return
  console.log(`Removing legacy service ${name}…`)
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway service delete --service ${name} --environment ${ENVIRONMENT} --yes --json`.quiet()
    )
  )
  if (error)
    console.warn(
      `Could not remove legacy service ${name}: ${stderrOf(error)}\n` +
        `  Remove it manually — otherwise it runs a second, stale Base liquidator with a funded key.`
    )
  else console.log(`Removed legacy service ${name}.`)
}

async function ensureVolume(service: string, mountPath: string): Promise<void> {
  const { data } = await tryCatch(Promise.resolve($`railway volume list --json`.quiet().text()))
  const mounts = typeof data === 'string' ? parseVolumeMounts(data) : []
  // Match this service's own volume — NOT merely a same-mount volume elsewhere in the environment.
  // Volumes are per-service, so each bot needs its own `/config`; keying on mountPath alone made every
  // bot after the first (and after a legacy service left an orphaned `/config`) skip provisioning.
  if (mounts.some(mount => mount.serviceName === service && mount.mountPath === mountPath)) {
    console.log(`Volume at ${mountPath} already on ${service}.`)
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
  // Pass -p/-e explicitly: `railway link` doesn't reliably carry the environment into this non-TTY
  // subprocess, so `railway up` otherwise errors "No environment specified". Self-contained > ambient.
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway up -s ${service} -e ${ENVIRONMENT} -p ${PROJECT_ID} -d`.cwd(REPO_ROOT).quiet()
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

await assertCli()

// The chains this deploy targets: one `bot-<chainId>` service each, all sharing the one rindexer +
// Postgres. `network` must match the rindexer.yaml network name and the bot's chain map. Add a chain
// here + in rindexer.yaml + in src/config.ts to extend coverage.
type ChainDeploy = { chainId: number; network: string; service: string }
const CHAINS: ChainDeploy[] = [
  { chainId: 8453, network: 'base', service: 'bot-8453' },
  { chainId: 4663, network: 'robinhood', service: 'bot-4663' }
]
// The pre-multichain single-chain service name, retired after `bot-8453` is confirmed healthy.
const LEGACY_BOT_SERVICE = 'bot'

// Read a chainId-suffixed env var (e.g. RPC_URL_8453). RPC endpoints differ per chain so these are
// effectively required per chain; the private key may instead fall back to a shared unsuffixed key.
function suffixed(name: string, chainId: number): string | undefined {
  return Bun.env[`${name}_${chainId}`]?.trim() || undefined
}
function requiredSuffixed(name: string, chainId: number): string {
  const value = suffixed(name, chainId)
  if (!value) throw new Error(`Missing required env var: ${name}_${chainId}`)
  return value
}

// Per-chain secrets/config, read + validated up front so we fail loud before mutating Railway state.
const chainSecrets = CHAINS.map(chain => {
  const rpcUrl = requiredSuffixed('RPC_URL', chain.chainId)
  // rindexer indexes each network from its own RPC; default to the bot's RPC for that chain.
  const rindexerRpcUrl = suffixed('RINDEXER_RPC_URL', chain.chainId) ?? rpcUrl
  // A single funded key may be reused across chains (unsuffixed fallback), or set one per chain.
  const liquidatorPrivateKey =
    suffixed('LIQUIDATOR_PRIVATE_KEY', chain.chainId) ?? Bun.env.LIQUIDATOR_PRIVATE_KEY?.trim()
  if (!liquidatorPrivateKey)
    throw new Error(
      `Missing required env var: LIQUIDATOR_PRIVATE_KEY_${chain.chainId} (or a shared LIQUIDATOR_PRIVATE_KEY)`
    )
  assertPrivateKey(liquidatorPrivateKey)
  // Aggregator keys are optional (only if the chain's swap config routes a collateral through them).
  const zeroxApiKey = suffixed('ZEROX_API_KEY', chain.chainId) ?? Bun.env.ZEROX_API_KEY?.trim()
  const oneInchApiKey =
    suffixed('ONEINCH_API_KEY', chain.chainId) ?? Bun.env.ONEINCH_API_KEY?.trim()
  return { ...chain, rpcUrl, rindexerRpcUrl, liquidatorPrivateKey, zeroxApiKey, oneInchApiKey }
})

await ensureContext()
const postgresName = await ensurePostgres()
// Railway reference variable; `${{ }}` is a literal here (single-quoted, so JS does not interpolate
// it) and Railway resolves it to the Postgres connection string at runtime.
const databaseUrlRef = 'DATABASE_URL=${{' + postgresName + '.DATABASE_URL}}'

// --- rindexer: ONE shared process indexing every chain's Borrow events into Postgres (BUILD_TARGET
// selects the rindexer stage). Each network reads its own RPC via RINDEXER_RPC_URL_<chainId>, matching
// the `${RINDEXER_RPC_URL_<chainId>}` interpolations in rindexer.yaml.
await ensureService('rindexer')
await setVar('rindexer', `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
await setVar('rindexer', 'BUILD_TARGET=rindexer')
await setVar('rindexer', 'PROJECT_PATH=/app/project_path')
await setVar('rindexer', databaseUrlRef)
for (const chain of chainSecrets) {
  await setSecret('rindexer', `RINDEXER_RPC_URL_${chain.chainId}`, chain.rindexerRpcUrl)
}
await deployService('rindexer')

// --- bot-<chainId>: one liquidation runner per chain (BUILD_TARGET selects the bun bot stage), all
// sharing the one rindexer + Postgres. The in-container var names stay RPC_URL / LIQUIDATOR_PRIVATE_KEY
// (the chainId suffix is only an operator-side convention). Swap config lives on a per-service /config
// volume (uploaded out-of-band — see manual steps below).
for (const chain of chainSecrets) {
  await ensureService(chain.service)
  await ensureVolume(chain.service, SWAP_MOUNT_PATH)
  await setVar(chain.service, `CHAIN_ID=${chain.chainId}`)
  await setVar(chain.service, `RAILWAY_DOCKERFILE_PATH=${DOCKERFILE_PATH}`)
  await setVar(chain.service, 'BUILD_TARGET=bot')
  await setVar(chain.service, `SWAP_CONFIG_PATH=${SWAP_CONFIG_PATH}`)
  await setVar(chain.service, 'LOG_LEVEL=info')
  await setVar(chain.service, databaseUrlRef)
  await setSecret(chain.service, 'RPC_URL', chain.rpcUrl)
  await setSecret(chain.service, 'LIQUIDATOR_PRIVATE_KEY', chain.liquidatorPrivateKey)
  if (chain.zeroxApiKey) await setSecret(chain.service, 'ZEROX_API_KEY', chain.zeroxApiKey)
  if (chain.oneInchApiKey) await setSecret(chain.service, 'ONEINCH_API_KEY', chain.oneInchApiKey)
  await deployService(chain.service)
}

const rindexerStatus = await waitForDeploy('rindexer')
const botStatuses = new Map<string, string>()
for (const chain of chainSecrets) botStatuses.set(chain.service, await waitForDeploy(chain.service))

// Cutover: retire the pre-multichain `bot` service ONLY once its replacement `bot-8453` is healthy,
// so the Base liquidator is never left without a running instance. Leaving `bot` up would run a
// second, stale Base liquidator with a funded key alongside bot-8453 (nonce contention/double-submits).
const baseService = CHAINS.find(chain => chain.chainId === 8453)?.service
if (baseService && botStatuses.get(baseService) === 'SUCCESS') {
  await removeService(LEGACY_BOT_SERVICE)
} else {
  console.warn(
    `Skipping '${LEGACY_BOT_SERVICE}' removal — bot-8453 not confirmed SUCCESS. Remove it manually ` +
      `once bot-8453 is healthy to avoid a stale second Base liquidator.`
  )
}

console.log('')
console.log('=== Deployment status ===')
console.log(`  rindexer: ${rindexerStatus}`)
for (const [service, status] of botStatuses) console.log(`  ${service}: ${status}`)
console.log('')
console.log('=== Manual steps ===')
console.log(`  1. For each chain that should ROUTE liquidations, upload swap.json into that bot's`)
console.log(`     ${SWAP_MOUNT_PATH} volume (the bot boots without it — no routes: it identifies`)
console.log('     borrowers but skips every routed liquidation). The volume mounts only into a')
console.log('     running container, so do this once the bot is up, e.g. for Base:')
console.log(`       railway volume files upload ./swap.config.json ${SWAP_CONFIG_PATH} --overwrite`)
console.log('     (prompts for the volume; or pass --volume <name> before the subcommand. Shape:')
console.log(
  '     packages/blue-liquidation/configs/example.json.) Restart that bot afterward to pick up routes.'
)
console.log('     Robinhood (bot-4663) launches DETECTION-ONLY — no swap route configured yet.')
console.log('  2. Each bot needs a funded key + a real RPC before it can broadcast; Robinhood also')
console.log('     needs the Executor deployed (bun run --filter @repo/contracts deploy:executor).')

// FAILED/TIMEOUT signal a real build or platform problem; a bot CRASH pre-config is expected.
const badStatus = (status: string) => status === 'FAILED' || status === 'TIMEOUT'
process.exitCode = badStatus(rindexerStatus) || [...botStatuses.values()].some(badStatus) ? 1 : 0
