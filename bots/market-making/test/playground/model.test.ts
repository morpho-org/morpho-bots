import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'

import {
  BOOTSTRAP_FIELDS,
  BOT_ENVIRONMENT_KEYS,
  LADDER_FIELDS,
  OBSERVABILITY_FIELDS,
  SCALAR_FIELDS,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  exportJson,
  exportShell,
  exportYaml,
  generatePreviewLadders,
  validatePlaygroundState
} from '../../playground/model'
import { ConfigService } from '../../src/config/config.service'

const loadShellEnvironment = async (text: string) => {
  const process = Bun.spawn(['dash', '-c', `${text}\n/usr/bin/env -0`], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited
  ])
  if (exitCode !== 0) throw new Error(stderr)
  return Object.fromEntries(
    Buffer.from(stdout)
      .toString()
      .split('\0')
      .filter(Boolean)
      .map(entry => {
        const separator = entry.indexOf('=')
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      })
  )
}

const validateWithProductionLoader = (environment: Record<string, string>) =>
  ConfigService.from(environment)

describe('market-maker parameter playground', () => {
  test('inventory independently parses runtime source, env example, and YAML example', async () => {
    const [source, environmentExample, yamlExampleText] = await Promise.all([
      Bun.file(new URL('../../src/config/config-source.utils.ts', import.meta.url)).text(),
      Bun.file(new URL('../../.env.example', import.meta.url)).text(),
      Bun.file(new URL('../../market-making.example.yaml', import.meta.url)).text()
    ])
    const envBlock = source.match(/const environmentKeys = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    const runtimeKeys = [...envBlock.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(match => match[1]!)
    const yamlBlock = source.match(/const yamlKeys = \{([\s\S]*?)\n\} as const/)?.[1] ?? ''
    const nestedYamlKeys: Record<string, string[]> = Object.fromEntries(
      [
        ...yamlBlock.matchAll(
          /(root|chain|identity|contracts|apis|markets|setup|bootstrap|ladder): \[([\s\S]*?)\]/g
        )
      ].map(match => [match[1]!, [...match[2]!.matchAll(/'([^']+)'/g)].map(item => item[1]!)])
    )
    const exampleKeys = [...environmentExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      match => match[1]!
    )
    const yamlExample = parseDocument(yamlExampleText, { schema: 'failsafe' }).toJS() as Record<
      string,
      Record<string, unknown> | Record<string, unknown>[]
    >
    const yamlPathBlock =
      source.match(/const yamlEnvironmentPaths[\s\S]*?= \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const yamlScalarEnvironmentKeys = [
      ...yamlPathBlock.matchAll(/([A-Z][A-Z0-9_]*): \['([^']+)', '([^']+)'\]/g)
    ]
      .filter(match => {
        const group = yamlExample[match[2]!]
        return !Array.isArray(group) && group !== undefined && match[3]! in group
      })
      .map(match => match[1]!)
    const bootstrapExample = yamlExample.bootstrap
    const ladderExample = yamlExample.ladder
    const bootstrapExampleKeys = Array.isArray(bootstrapExample)
      ? Object.keys(bootstrapExample[0] ?? {})
      : []
    const ladderExampleKeys = Array.isArray(ladderExample)
      ? Object.keys(ladderExample[0] ?? {})
      : []

    expect(runtimeKeys).toEqual(SCALAR_FIELDS.map(([key]) => key) as string[])
    expect(exampleKeys).toEqual([
      ...SCALAR_FIELDS.map(([key]) => key),
      ...OBSERVABILITY_FIELDS.map(([key]) => key),
      'BOOTSTRAP_MARKETS',
      'LADDER_MARKETS'
    ])
    expect([...BOT_ENVIRONMENT_KEYS] as string[]).toEqual(exampleKeys)
    expect(yamlScalarEnvironmentKeys).toEqual(SCALAR_FIELDS.map(([key]) => key) as string[])
    expect(BOOTSTRAP_FIELDS.map(([key]) => key) as string[]).toEqual(nestedYamlKeys.bootstrap ?? [])
    expect(bootstrapExampleKeys).toEqual(BOOTSTRAP_FIELDS.map(([key]) => key) as string[])
    expect(LADDER_FIELDS.map(([key]) => key) as string[]).toEqual(nestedYamlKeys.ladder ?? [])
    expect(ladderExampleKeys).toEqual(LADDER_FIELDS.map(([key]) => key) as string[])
  })

  test('does not expose the lossy dotenv format in the model or browser UI', async () => {
    const [model, application, document] = await Promise.all([
      Bun.file(new URL('../../playground/model.ts', import.meta.url)).text(),
      Bun.file(new URL('../../playground/app.ts', import.meta.url)).text(),
      Bun.file(new URL('../../playground/index.html', import.meta.url)).text()
    ])
    expect(model).not.toContain('exportDotenv')
    expect(application).not.toContain('dotenv')
    expect(document).not.toContain('Dotenv')
    expect(document).toContain('Shell-safe ENV')
  })

  test('shell export literally round-trips every hostile character through POSIX dash without execution', async () => {
    await rm('/tmp/playground-pwned', { force: true })
    const state = createDefaultPlaygroundState()
    const hostile = ' leading # value \\ $HOME $(touch /tmp/playground-pwned) `id` ;&|<>\nnext=\'" '
    state.observability.BETTERSTACK_SOURCE_TOKEN = hostile
    state.observability.BETTERSTACK_INGESTING_HOST = 'logs.example.test'
    const output = exportShell(state)
    const roundTripPath = '/tmp/playground-roundtrip'
    await rm(roundTripPath, { force: true })
    await writeFile(roundTripPath, `${output}\nprintf '%s' "$BETTERSTACK_SOURCE_TOKEN"`)
    const process = Bun.spawn(['dash', roundTripPath], { stdout: 'pipe', stderr: 'pipe' })
    const [roundTripped, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(roundTripped).toBe(hostile)
    expect(await Bun.file('/tmp/playground-pwned').exists()).toBe(false)
  })

  test('uses production ladder allocation and applies target and total exposure caps', () => {
    const state = createDefaultPlaygroundState()
    const config = state.ladder[0]!
    config.rungCount = '3'
    config.minimumOfferAssets = '1'
    config.lowerRateBudgetAssets = '1000'
    config.higherRateBudgetAssets = '1000'
    config.targetMarketExposureAssets = '100'
    config.maximumTotalExposureAssets = '1000'

    const [preview] = generatePreviewLadders(state)
    expect(preview?.higher.reduce((sum, rung) => sum + BigInt(rung.assets), 0n)).toBe(100n)
    expect(preview?.lower.reduce((sum, rung) => sum + BigInt(rung.assets), 0n)).toBe(1000n)
  })

  test('rejects production-invalid ladder shape and blocks every export', () => {
    const state = createDefaultPlaygroundState()
    state.ladder[0]!.stepBps = '0'
    state.ladder[0]!.lowerRateBudgetAssets = '0'
    state.ladder[0]!.targetMarketExposureAssets = '1001'
    state.ladder[0]!.maximumTotalExposureAssets = '1000'
    state.ladder[0]!.loopIntervalSeconds = '2147484'
    state.ladder[0]!.minimumRateBps = '499'
    state.ladder[0]!.maximumRateBps = '500'

    const result = validatePlaygroundState(state)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('stepBps')
    for (const exporter of [exportYaml, exportShell, exportJson]) {
      expect(() => exporter(state)).toThrow('Configuration is invalid')
    }
  })

  test('supports empty, single, and ordered multiple bootstrap and ladder entries', async () => {
    const state = createDefaultPlaygroundState()
    state.bootstrap = []
    state.ladder = []
    const empty = await loadShellEnvironment(exportShell(state))
    expect(empty.BOOTSTRAP_MARKETS).toBe('[]')
    expect(empty.LADDER_MARKETS).toBe('[]')

    const secondMarket = `0x${'6'.repeat(64)}`
    const originalMarket = state.scalar.MARKET_IDS.split(',')[0]!
    state.scalar.MARKET_IDS = `${originalMarket},${secondMarket}`
    state.bootstrap = [createDefaultBootstrap(secondMarket), createDefaultBootstrap(originalMarket)]
    state.ladder = [createDefaultLadder(secondMarket), createDefaultLadder(originalMarket)]

    const parsed = await loadShellEnvironment(exportShell(state))
    expect(
      JSON.parse(parsed.BOOTSTRAP_MARKETS ?? '').map(
        (entry: { marketId: string }) => entry.marketId
      )
    ).toEqual([secondMarket, originalMarket])
    expect(
      JSON.parse(parsed.LADDER_MARKETS ?? '').map((entry: { marketId: string }) => entry.marketId)
    ).toEqual([secondMarket, originalMarket])
    expect(generatePreviewLadders(state).map(preview => preview.marketId)).toEqual([
      secondMarket,
      originalMarket
    ])
  })

  test('blank market lists export as empty arrays and round-trip through every real loader', async () => {
    const state = createDefaultPlaygroundState()
    state.scalar.MARKET_IDS = ''
    state.scalar.V0_OFFER_GROUP_IDS = ''
    state.bootstrap = []
    state.ladder = []

    expect(validatePlaygroundState(state)).toEqual({ valid: true, errors: [] })

    const yaml = exportYaml(state)
    const parsedYaml = parseDocument(yaml, { schema: 'failsafe' }).toJS() as {
      markets: { allowlist: unknown; v0OfferGroupIds: unknown }
    }
    expect(parsedYaml.markets.allowlist).toEqual([])
    expect(parsedYaml.markets.v0OfferGroupIds).toEqual([])

    const environment = await loadShellEnvironment(exportShell(state))
    expect(environment.MARKET_IDS).toBe('')
    expect(environment.V0_OFFER_GROUP_IDS).toBe('')
    expect(validateWithProductionLoader(environment).setup.marketIds).toEqual([])
    expect(validateWithProductionLoader(environment).v0OfferGroupIds).toEqual([])

    const json = JSON.parse(exportJson(state)) as {
      configuration: { MARKET_IDS: unknown; V0_OFFER_GROUP_IDS: unknown }
    }
    expect(json.configuration.MARKET_IDS).toEqual([])
    expect(json.configuration.V0_OFFER_GROUP_IDS).toEqual([])

    const cwd = '/tmp/morpho-playground-empty-roundtrip'
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(`${cwd}/market-making.yaml`, yaml)
    const loaded = await ConfigService.load({}, { cwd })
    expect(loaded.setup.marketIds).toEqual([])
    expect(loaded.v0OfferGroupIds).toEqual([])
  })

  test('valid exports round-trip through real environment and YAML config loaders', async () => {
    const state = createDefaultPlaygroundState()
    const env = await loadShellEnvironment(exportShell(state))
    expect(validateWithProductionLoader(env).ladder).toHaveLength(1)

    const cwd = '/tmp/morpho-playground-roundtrip'
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(`${cwd}/market-making.yaml`, exportYaml(state))
    const loaded = await ConfigService.load({}, { cwd })
    expect(loaded.bootstrap).toHaveLength(1)
    expect(loaded.ladder).toHaveLength(1)
  })
})
