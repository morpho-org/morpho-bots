import fs from 'node:fs'

export type Stage = 'staging' | 'production'

interface BotManifestEntry {
  /** Stable bot id: the `Releases <id>` token, release tag prefix, and label suffix. */
  id: string
  /** Workspace package whose `deploy:railway` script ships the bot. */
  package: string
  /** GitHub Environment holding RAILWAY_TOKEN + RAILWAY_PROJECT_ID per stage. */
  environments: { staging?: string; production: string }
}

/** One deploy matrix leg, consumed by `deploy-bot.yml` inputs. */
interface DeployTarget {
  bot: string
  package: string
  stage: Stage
  environment: string
}

const MANIFEST_URL = new URL('../../manifest.json', import.meta.url)
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function loadManifest(): BotManifestEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8'))
  return validateManifest(parsed)
}

export function validateManifest(parsed: unknown): BotManifestEntry[] {
  if (!Array.isArray(parsed)) throw new Error('manifest.json must be an array')
  const ids = new Set<string>()
  return parsed.map((entry: unknown, index) => {
    const { id, package: pkg, environments } = (entry ?? {}) as Partial<BotManifestEntry>
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new Error(`manifest.json[${index}]: id must match ${ID_RE}`)
    }
    if (ids.has(id)) throw new Error(`manifest.json: duplicate id ${id}`)
    ids.add(id)
    if (typeof pkg !== 'string' || pkg === '') {
      throw new Error(`manifest.json[${index}] (${id}): package is required`)
    }
    if (typeof environments?.production !== 'string' || environments.production === '') {
      throw new Error(`manifest.json[${index}] (${id}): environments.production is required`)
    }
    if (environments.staging !== undefined && typeof environments.staging !== 'string') {
      throw new Error(`manifest.json[${index}] (${id}): environments.staging must be a string`)
    }
    return { id, package: pkg, environments }
  })
}

export function botIds(manifest: readonly BotManifestEntry[]): Set<string> {
  return new Set(manifest.map(entry => entry.id))
}

/** The bots deployable to `stage`, optionally narrowed to `bots`, as matrix legs. */
export function deployTargets(
  manifest: readonly BotManifestEntry[],
  stage: Stage,
  bots?: readonly string[]
): DeployTarget[] {
  return manifest
    .filter(entry => bots === undefined || bots.includes(entry.id))
    .flatMap(entry => {
      const environment = entry.environments[stage]
      return environment ? [{ bot: entry.id, package: entry.package, stage, environment }] : []
    })
}
