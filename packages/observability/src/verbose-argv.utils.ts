import type { Environment } from './shipping-config.utils'

import { hasShippingConfig } from './shipping-config.utils'

const DEFAULT_VALUE_OPTIONS = ['--config', '-c'] as const

const commandOf = (argv: readonly string[], valueOptions: readonly string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (valueOptions.includes(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    return argument
  }
  return undefined
}

/**
 * Enables a bot's safe verbose event stream only when an observability sink is configured.
 * @param argv - CLI arguments without runtime or executable prefixes.
 * @param options - Verbose-capable command allowlist, the environment used only to detect
 * complete BetterStack shipping configuration, a caller-detected additional sink (for example an
 * OpenTelemetry export opt-in) that also warrants the stream, and the bot's value-taking root
 * options whose values must not be mistaken for the command.
 * @returns A copied argument list, with `--verbose` added for allowlisted commands when needed.
 * @remarks Pure argument transformation; it performs no logging, shipping, or process mutation.
 * `valueOptions` defaults to the `--config`/`-c` pair every bot supports; a bot with more
 * value-taking root options (a keystore path, a private key) must list them or an option value
 * preceding the command suppresses the stream.
 */
export const enhanceVerboseArgv = (
  argv: readonly string[],
  options: {
    commands: readonly string[]
    env?: Environment
    hasAdditionalSink?: boolean
    valueOptions?: readonly string[]
  }
): readonly string[] => {
  const env = options.env ?? process.env
  const sinkConfigured = hasShippingConfig(env) || options.hasAdditionalSink === true
  if (!sinkConfigured || argv.includes('--verbose')) return [...argv]
  const command = commandOf(argv, options.valueOptions ?? DEFAULT_VALUE_OPTIONS)
  if (command === undefined || !options.commands.includes(command)) return [...argv]
  return [...argv, '--verbose']
}
