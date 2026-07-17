import { resolve } from 'node:path'
const projectId = required('RAILWAY_PROJECT_ID')
const environment = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const service = 'bot'
const repoRoot = resolve(import.meta.dir, '..', '..', '..')
function required(name: string) {
  const value = Bun.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
async function run(args: string[], options: { cwd?: string; stdin?: string } = {}) {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(' ')} failed: ${stderr.trim()}`)
  return stdout
}
async function setVar(key: string, value: string, secret = false) {
  const args = secret
    ? ['railway', 'variable', 'set', key, '--stdin', '-s', service, '--skip-deploys']
    : ['railway', 'variable', 'set', `${key}=${value}`, '-s', service, '--skip-deploys']
  await run(args, secret ? { stdin: value } : {})
  console.log(`Set ${key}${secret ? ' (secret)' : ''}.`)
}
await run(['railway', '--version'])
if (!Bun.env.RAILWAY_TOKEN) await run(['railway', 'link', '-p', projectId, '-e', environment])
const rows = JSON.parse(await run(['railway', 'service', 'list', '--json'])) as Array<{
  name?: string
}>
if (!rows.some(row => row.name === service))
  await run(['railway', 'add', '--service', service, '--json'])
if (!/^(1|true)$/i.test(Bun.env.DEPLOY_ONLY?.trim() || '')) {
  await setVar('CHAIN_ID', '8453')
  await setVar('MIDNIGHT_MARKETS_JSON', required('MIDNIGHT_MARKETS_JSON'))
  for (const key of [
    'RPC_URL_FALLBACK',
    'MIDNIGHT_API_URL',
    'OFFER_TTL_SECONDS',
    'PUBLISH_LEAD_SECONDS',
    'LOOP_INTERVAL_SECONDS',
    'MAX_FEE_GWEI',
    'DRY_RUN',
    'LOG_LEVEL',
    'BETTERSTACK_INGESTING_HOST'
  ]) {
    const value = Bun.env[key]?.trim()
    if (value) await setVar(key, value)
  }
  await setVar('RPC_URL', required('RPC_URL'), true)
  await setVar('MAKER_PRIVATE_KEY', required('MAKER_PRIVATE_KEY'), true)
  if (Bun.env.BETTERSTACK_SOURCE_TOKEN?.trim())
    await setVar('BETTERSTACK_SOURCE_TOKEN', Bun.env.BETTERSTACK_SOURCE_TOKEN.trim(), true)
}
await run(['railway', 'up', '-s', service, '-p', projectId, '-e', environment, '-d'], {
  cwd: repoRoot
})
console.log(`Deployment started for ${service}.`)
