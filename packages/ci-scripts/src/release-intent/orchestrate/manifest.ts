import { setFailed, setOutput } from '../../lib/actions'
import { deployTargets, loadManifest, type Stage } from '../manifest'

/** Emits the `deploy-bot.yml` matrix (`targets`) for the stage given as the first argument. */
function main(): void {
  const stage = process.argv[2]
  if (stage !== 'staging' && stage !== 'production') {
    throw new Error(`usage: release-manifest <staging|production> (got ${stage ?? 'nothing'})`)
  }
  setOutput('targets', JSON.stringify(deployTargets(loadManifest(), stage as Stage)))
}

try {
  main()
} catch (err: unknown) {
  setFailed(err instanceof Error ? err.message : String(err))
}
