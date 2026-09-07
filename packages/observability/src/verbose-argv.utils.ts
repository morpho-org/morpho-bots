import type { Environment } from './shipping-config.utils'

import { hasShippingConfig } from './shipping-config.utils'

const commandOf = (argv: readonly string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config' || argument === '-c') {
      index += 1
      continue
    }
    if (argument?.startsWith('--config=') || argument?.startsWith('-')) continue
    return argument
  }
  return undefined
}

/**
 * Enables a bot's safe verbose event stream only when an observability sink is configured.
 * @param argv - CLI arguments without runtime or executable prefixes.
 * @param options - Verbose-capable command allowlist, the environment used only to detect
 * complete BetterStack shipping configuration, and a caller-detected additional sink (for
 * example an OpenTelemetry export opt-in) that also warrants the stream.
 * @returns A copied argument list, with `--verbose` added for allowlisted commands when needed.
 * @remarks Pure argument transformation; it performs no logging, shipping, or process mutation.
 */
export const enhanceVerboseArgv = (
  argv: readonly string[],
  options: { commands: readonly string[]; env?: Environment; hasAdditionalSink?: boolean }
): readonly string[] => {
  const env = options.env ?? process.env
  const sinkConfigured = hasShippingConfig(env) || options.hasAdditionalSink === true
  if (!sinkConfigured || argv.includes('--verbose')) return [...argv]
  const command = commandOf(argv)
  if (command === undefined || !options.commands.includes(command)) return [...argv]
  return [...argv, '--verbose']
}
