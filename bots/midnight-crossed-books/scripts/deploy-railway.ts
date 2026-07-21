import { tryCatch } from '@repo/utils'
import { $ } from 'bun'
import { resolve } from 'node:path'

const project = required('RAILWAY_PROJECT_ID')
const environment = Bun.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const service = environment === 'production' ? 'bot' : `${environment}-bot`
const repoRoot = resolve(import.meta.dir, '..', '..', '..')

function required(name: string) {
  const value = Bun.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function ensureContext() {
  if (Bun.env.RAILWAY_TOKEN) return
  const { error } = await tryCatch(
    Promise.resolve($`railway link -p ${project} -e ${environment}`.quiet())
  )
  if (error) throw new Error(`Failed to link Railway project ${project}`)
}

async function ensureService() {
  const listed = await tryCatch(Promise.resolve($`railway service list --json`.quiet().text()))
  if (!listed.error && listed.data.includes(`"name":"${service}"`)) return
  const { error } = await tryCatch(Promise.resolve($`railway add --service ${service} --json`.quiet()))
  if (error) throw new Error(`Failed to create Railway service ${service}`)
}

async function setVar(value: string) {
  const { error } = await tryCatch(
    Promise.resolve($`railway variable set ${value} -s ${service} --skip-deploys`.quiet())
  )
  if (error) throw new Error(`Failed to set ${value.split('=')[0]}`)
}

async function setSecret(name: string, value: string) {
  const { error } = await tryCatch(
    Promise.resolve(
      $`railway variable set ${name} --stdin -s ${service} --skip-deploys < ${Buffer.from(value)}`.quiet()
    )
  )
  if (error) throw new Error(`Failed to set ${name}`)
}

await ensureContext()
if (!/^(1|true)$/i.test(Bun.env.DEPLOY_ONLY?.trim() || '')) {
  const key = required('RESOLVER_PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  await ensureService()
  await setVar('CHAIN_ID=8453')
  await setVar('RAILWAY_DOCKERFILE_PATH=bots/midnight-crossed-books/Dockerfile')
  await setSecret('RPC_URL', required('RPC_URL'))
  await setSecret('RESOLVER_PRIVATE_KEY', key)
}
const deployed = await tryCatch(
  Promise.resolve(
    $`railway up -s ${service} -p ${project} -e ${environment} -d`.cwd(repoRoot).quiet()
  )
)
if (deployed.error) throw new Error(`Failed to deploy Railway service ${service}`)
