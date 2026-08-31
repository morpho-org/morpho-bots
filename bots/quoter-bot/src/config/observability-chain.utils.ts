import type { Environment } from './config.utils'

import { loadConfigurationSources } from './config-source.utils'
import { BASE_CHAIN_ID, observabilityChainId } from './supported-chains.utils'

/**
 * Reads the configuration path from raw argv without running full CLI parsing.
 * @param argv - Process arguments following the executable and script.
 * @returns The explicit configuration path, or `undefined` when the flag is absent or has no value.
 * @remarks Argv is inspected directly because observability is created before the CLI parses its
 * options; a malformed flag is ignored here and reported later by real parsing. Both spellings the
 * CLI declares are accepted (`-c, --config <path>`), so a short-flag invocation is not silently
 * labelled with the wrong chain.
 */
const explicitConfigPath = (argv: readonly string[]) => {
  const index = argv.findIndex(argument => argument === '--config' || argument === '-c')
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1]
  const inline = argv.find(argument => argument.startsWith('--config='))
  return inline?.slice('--config='.length) || undefined
}

/**
 * Resolves the chain used to label observability from the same sources configuration reads.
 * @param environment - Process environment; `CHAIN_ID` takes precedence over any YAML value.
 * @param argv - Process arguments inspected for an explicit `--config` path.
 * @returns The configured chain when it resolves to a supported chain, otherwise {@link BASE_CHAIN_ID}.
 * @remarks Selecting mainnet through `quoter-bot.yaml` alone leaves `CHAIN_ID` unset, so reading the
 * environment by itself would label every lifecycle and monitoring record `8453` while the bot
 * operated on chain 1. This never throws or reports configuration problems: a malformed file must
 * surface as the precise `ConfigFileError` or `ConfigValidationError` raised moments later by real
 * configuration loading, not as an unlabelled crash during logger startup.
 */
export const resolveObservabilityChainId = async (
  environment: Environment,
  argv: readonly string[] = []
) => {
  if (environment.CHAIN_ID?.trim()) return observabilityChainId(environment)
  try {
    const source = await loadConfigurationSources(environment, {
      configPath: explicitConfigPath(argv),
      readOnly: true
    })
    return observabilityChainId(source.values as Environment)
  } catch {
    return BASE_CHAIN_ID
  }
}
