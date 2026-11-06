import { classifyShippingConfig } from '@repo/kit'

/** CLI commands whose safe verbose event stream is auto-enabled when a sink is configured. */
export const QUOTER_BOT_VERBOSE_COMMANDS: readonly string[] = ['start', 'bootstrap', 'ladder']

/** Value-taking root options whose values must not be mistaken for the command. */
export const QUOTER_BOT_ROOT_VALUE_OPTIONS: readonly string[] = [
  '--config',
  '-c',
  '--keystore',
  '--password',
  '--private-key'
]

const commandOf = (argv: readonly string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (QUOTER_BOT_ROOT_VALUE_OPTIONS.includes(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    return argument
  }
  return undefined
}

/**
 * Enables the safe verbose event stream for a writer command only when a sink will receive it.
 * @param argv - CLI arguments without runtime or executable prefixes.
 * @param options - The environment read only for a complete Better Stack opt-in, and whether
 * another sink (OpenTelemetry export) is enabled.
 * @returns A copied argument list, with `--verbose` appended for a writer command when needed.
 */
export const enhanceVerboseArgv = (
  argv: readonly string[],
  options: { env: Record<string, string | undefined>; hasAdditionalSink: boolean }
): readonly string[] => {
  const sinkConfigured =
    classifyShippingConfig(options.env).state === 'enabled' || options.hasAdditionalSink
  if (!sinkConfigured || argv.includes('--verbose')) return [...argv]
  const command = commandOf(argv)
  if (command === undefined || !QUOTER_BOT_VERBOSE_COMMANDS.includes(command)) return [...argv]
  return [...argv, '--verbose']
}
