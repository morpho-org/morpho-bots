import { parseHttpHeartbeatUrl } from '@repo/bot-kit/heartbeat-url'
import { classifyShippingConfig } from '@repo/bot-kit/shipping-config'
import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'

import {
  BOOTSTRAP_FIELDS,
  BOT_ENVIRONMENT_KEYS,
  LADDER_FIELDS,
  OBSERVABILITY_FIELDS,
  SCALAR_FIELDS,
  SENSITIVE_UI_KEYS,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  exportJson,
  exportShell,
  exportYaml,
  generateLadderGraphicModels,
  generatePreviewLadders,
  getObservabilityStatuses,
  validatePreviewState,
  validateProductionState,
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

const productionEnvironment = (state: ReturnType<typeof createDefaultPlaygroundState>) => ({
  ...state.scalar,
  BOOTSTRAP_MARKETS: JSON.stringify(state.bootstrap),
  LADDER_MARKETS: JSON.stringify(state.ladder),
  ...state.observability
})

const productionAccepts = (state: ReturnType<typeof createDefaultPlaygroundState>) => {
  try {
    validateWithProductionLoader(productionEnvironment(state))
    return true
  } catch {
    return false
  }
}

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
    const output = exportShell(state, { includeSensitiveValues: true })
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

  test('treats target as the static binding cap while total exposure is annotation-only without live state', () => {
    const state = createDefaultPlaygroundState()
    const config = state.ladder[0]!
    config.rungCount = '3'
    config.minimumOfferAssets = '1'
    config.lowerRateBudgetAssets = '1000'
    config.higherRateBudgetAssets = '1000'
    config.targetMarketExposureAssets = '100'
    config.maximumTotalExposureAssets = '1000'

    const [baseline] = generateLadderGraphicModels(state)
    config.maximumTotalExposureAssets = '500'
    const [differentValidTotal] = generateLadderGraphicModels(state)
    expect(differentValidTotal?.rungs.map(rung => rung.allocationAssets)).toEqual(
      baseline?.rungs.map(rung => rung.allocationAssets)
    )

    config.targetMarketExposureAssets = '80'
    const [differentTarget] = generateLadderGraphicModels(state)
    expect(
      differentTarget?.rungs
        .filter(rung => rung.side === 'higher')
        .reduce((sum, rung) => sum + BigInt(rung.allocationAssets), 0n)
    ).toBe(80n)
    expect(
      differentTarget?.rungs
        .filter(rung => rung.side === 'lower')
        .reduce((sum, rung) => sum + BigInt(rung.allocationAssets), 0n)
    ).toBe(1000n)
    expect(
      differentTarget?.callouts.find(callout => callout.label === 'Exposure caps')?.value
    ).toBe(
      '80 target (static binding cap) · 500 configured total ceiling; current aggregate exposure and live capacity excluded'
    )
  })

  test('models allocation and actual offer maxAssets distinctly in both group modes', () => {
    const state = createDefaultPlaygroundState()
    const input = state.ladder[0]!

    input.groupMode = 'shared-rung'
    const [shared] = generateLadderGraphicModels(state)
    input.groupMode = 'per-book'
    const [perBook] = generateLadderGraphicModels(state)

    expect(shared?.rungs.map(rung => rung.allocationAssets)).toEqual([
      '3333333334',
      '3333333333',
      '3333333333',
      '3333333333',
      '3333333333',
      '3333333334'
    ])
    expect(shared?.rungs.map(rung => rung.offerMaxAssets)).toEqual(
      shared?.rungs.map(rung => rung.allocationAssets)
    )
    expect(perBook?.rungs.map(rung => rung.allocationAssets)).toEqual(
      shared?.rungs.map(rung => rung.allocationAssets)
    )
    expect(perBook?.rungs.map(rung => rung.offerMaxAssets)).toEqual([
      '10000000000',
      '10000000000',
      '10000000000',
      '10000000000',
      '10000000000',
      '10000000000'
    ])
    expect(perBook?.rungs.map(rung => rung.allocationBarRatio)).toEqual(
      shared?.rungs.map(rung => rung.allocationBarRatio)
    )
    expect(perBook?.rungs.map(rung => rung.offerMaxBarRatio)).not.toEqual(
      shared?.rungs.map(rung => rung.offerMaxBarRatio)
    )
    expect(perBook?.callouts.find(callout => callout.label === 'Grouping')?.value).toBe(
      'per-book · side-wide shared cap · Reduce-only 10,000,000,000 · Lend 10,000,000,000 offer maxAssets'
    )
  })

  test('uses explicit allocation and offer maxAssets language in graphic rendering', async () => {
    const application = await Bun.file(new URL('../../playground/app.ts', import.meta.url)).text()
    expect(application).toContain('allocation')
    expect(application).toContain('offer maxAssets')
    expect(application.toLowerCase()).not.toContain('offer-size')
    expect(application.toLowerCase()).not.toContain('relative offer size')
  })

  test('proves every ladder field and reference rate through specific rendered model output', () => {
    const state = createDefaultPlaygroundState()
    const input = state.ladder[0]!
    input.minimumRateBps = '0'
    input.maximumRateBps = '2000'
    input.minimumOfferAssets = '1'
    input.lowerRateBudgetAssets = '1200'
    input.higherRateBudgetAssets = '900'
    input.targetMarketExposureAssets = '700'
    input.maximumTotalExposureAssets = '800'
    input.quotePremiumBps = '25'
    input.spreadBps = '220'
    input.stepBps = '110'
    input.rungCount = '4'
    input.sizeSkewBps = '1000'
    input.groupMode = 'per-book'
    input.loopIntervalSeconds = '30'
    input.movementToleranceBps = '20'
    state.referenceRateBps = '510'
    const marketId = `0x${'6'.repeat(64)}`
    state.scalar.MARKET_IDS = `${state.scalar.MARKET_IDS},${marketId}`
    input.marketId = marketId

    const [graphic] = generateLadderGraphicModels(state)
    expect(graphic?.marketId).toBe(marketId)
    expect(graphic?.axis).toMatchObject({
      minimumRateBps: '0',
      maximumRateBps: '2000',
      referenceRateBps: '510',
      centerRateBps: '535'
    })
    expect(graphic?.gapBps).toBe('220')
    expect(graphic?.rungs).toHaveLength(8)
    expect(graphic?.rungs.map(rung => rung.rateBps)).toEqual([
      '975',
      '865',
      '755',
      '645',
      '425',
      '315',
      '205',
      '95'
    ])
    expect(
      graphic?.rungs.filter(rung => rung.side === 'higher').map(rung => rung.allocationAssets)
    ).toEqual(['199', '182', '167', '152'])
    expect(
      graphic?.rungs.filter(rung => rung.side === 'lower').map(rung => rung.allocationAssets)
    ).toEqual(['261', '287', '313', '339'])
    expect(graphic?.rungs.map(rung => rung.offerMaxAssets)).toEqual([
      '700',
      '700',
      '700',
      '700',
      '1200',
      '1200',
      '1200',
      '1200'
    ])
    expect(graphic?.rungs.map(rung => rung.allocationBarRatio)).toEqual([
      0.1658, 0.1516, 0.1391, 0.1266, 0.2175, 0.2391, 0.2608, 0.2825
    ])
    expect(graphic?.rungs.map(rung => rung.offerMaxBarRatio)).toEqual([
      0.5833, 0.5833, 0.5833, 0.5833, 1, 1, 1, 1
    ])
    expect(graphic?.callouts.map(callout => callout.value)).toEqual([
      '510 + 25 = 535 BPS',
      '110 BPS steps · 220 BPS full gap',
      '4/side · 1000 BPS skew · 1 floor',
      '1200 reduce-only · 900 lend',
      '700 target (static binding cap) · 800 configured total ceiling; current aggregate exposure and live capacity excluded',
      'per-book · side-wide shared cap · Reduce-only 1,200 · Lend 700 offer maxAssets',
      '30s configured interval · 30s effective runtime cycle (minimum across configured markets) · 20 BPS informational deadband against retained active center; fresh stateless center unchanged',
      '0–2000 BPS'
    ])
  })

  test('allocates adaptive rate geometry with readable spacing at 32 and 512 rungs per side', () => {
    for (const rungCount of [32, 512]) {
      const state = createDefaultPlaygroundState()
      const input = state.ladder[0]!
      input.rungCount = String(rungCount)
      input.minimumOfferAssets = '1'
      input.minimumRateBps = '0'
      input.maximumRateBps = String(rungCount * 200 + 400)
      state.referenceRateBps = String(rungCount * 100 + 200)
      const [graphic] = generateLadderGraphicModels(state)
      const gaps = graphic!.rungs.slice(1).map((rung, index) => rung.y - graphic!.rungs[index]!.y)
      const nearestHigher = graphic!.rungs.findLast(rung => rung.side === 'higher')!
      const nearestLower = graphic!.rungs.find(rung => rung.side === 'lower')!

      expect(graphic?.rungs).toHaveLength(rungCount * 2)
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(28)
      expect(
        graphic!.rateToY(graphic!.axis.centerRateBps) - nearestHigher.y
      ).toBeGreaterThanOrEqual(28)
      expect(nearestLower.y - graphic!.rateToY(graphic!.axis.centerRateBps)).toBeGreaterThanOrEqual(
        28
      )
      expect(graphic!.plotHeight).toBeGreaterThanOrEqual(rungCount * 2 * 28)
    }
  })

  test('keeps huge bigint geometry finite and bounded without Number(bigint) conversion', () => {
    const powers = [100, 308, 400]
    for (const power of powers) {
      const state = createDefaultPlaygroundState()
      const input = state.ladder[0]!
      const unit = 10n ** BigInt(power)
      input.minimumRateBps = '0'
      input.maximumRateBps = String(unit * 8n)
      input.spreadBps = String(unit * 2n)
      input.stepBps = String(unit)
      state.referenceRateBps = String(unit * 4n)

      const [graphic] = generateLadderGraphicModels(state)
      expect(graphic).toBeDefined()
      expect(graphic!.plotHeight).toBeGreaterThanOrEqual(336)
      expect(graphic!.plotHeight).toBeLessThanOrEqual(32_768)
      expect(
        [
          graphic!.rateToY(graphic!.axis.minimumRateBps),
          graphic!.rateToY(graphic!.axis.maximumRateBps),
          ...graphic!.rungs.flatMap(rung => [
            rung.y,
            rung.allocationBarRatio,
            rung.offerMaxBarRatio
          ])
        ].every(Number.isFinite)
      ).toBe(true)
      expect(JSON.stringify(graphic!.rungs)).not.toMatch(/NaN|Infinity/)
    }
  })

  test('deterministic huge-rate fuzz never returns non-finite or impractical geometry', () => {
    let seed = 0x122n
    for (let sample = 0; sample < 64; sample++) {
      seed = (seed * 1_103_515_245n + 12_345n) % 2_147_483_648n
      const power = 100 + Number(seed % 301n)
      const unit = 10n ** BigInt(power)
      const state = createDefaultPlaygroundState()
      const input = state.ladder[0]!
      input.minimumRateBps = '0'
      input.maximumRateBps = String(unit * 8n)
      input.spreadBps = String(unit * 2n)
      input.stepBps = String(unit)
      state.referenceRateBps = String(unit * 4n)

      const [graphic] = generateLadderGraphicModels(state)
      expect(graphic!.plotHeight).toBeLessThanOrEqual(32_768)
      expect(
        graphic!.rungs.every(rung =>
          [rung.y, rung.allocationBarRatio, rung.offerMaxBarRatio].every(Number.isFinite)
        )
      ).toBe(true)
    }
  })

  test('keeps exports valid when practical plot dimensions require preview-only invalid state', () => {
    const state = createDefaultPlaygroundState()
    const input = state.ladder[0]!
    input.minimumRateBps = '0'
    input.maximumRateBps = `1${'0'.repeat(400)}`
    input.spreadBps = '2'
    input.stepBps = '1'
    state.referenceRateBps = '4'

    expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
    expect(() => generateLadderGraphicModels(state)).toThrow(
      'Preview geometry exceeds the 32768px practical plot-height limit'
    )
    for (const exporter of [exportYaml, exportShell, exportJson]) {
      expect(() => exporter(state)).not.toThrow()
      expect(exporter(state)).not.toMatch(/NaN|Infinity/)
    }
  })

  test('centrally inventories all UI credentials and redacts complete RPC URLs by default', async () => {
    expect([...SENSITIVE_UI_KEYS]).toEqual([
      'MAKER_PRIVATE_KEY',
      'BETTERSTACK_SOURCE_TOKEN',
      'RPC_URL',
      'REFERENCE_RPC_URL'
    ])
    const sensitiveFieldTypes = new Map(
      [...SCALAR_FIELDS, ...OBSERVABILITY_FIELDS].map(([key, , , type]) => [key, type])
    )
    for (const key of SENSITIVE_UI_KEYS) expect(sensitiveFieldTypes.get(key)).toBe('password')

    const state = createDefaultPlaygroundState()
    const values = {
      MAKER_PRIVATE_KEY: `0x${'9'.repeat(64)}`,
      BETTERSTACK_SOURCE_TOKEN: 'super-private-source-token',
      RPC_URL: 'https://rpc-user:rpc-password@rpc.example.test/path?api_key=query-secret#fragment',
      REFERENCE_RPC_URL:
        'https://archive-user:archive-password@archive.example.test/path?token=archive-secret'
    }
    state.scalar.MAKER_PRIVATE_KEY = values.MAKER_PRIVATE_KEY
    state.scalar.RPC_URL = values.RPC_URL
    state.scalar.REFERENCE_RPC_URL = values.REFERENCE_RPC_URL
    state.observability.BETTERSTACK_SOURCE_TOKEN = values.BETTERSTACK_SOURCE_TOKEN
    state.observability.BETTERSTACK_INGESTING_HOST = 'logs.example.test'

    for (const exporter of [exportYaml, exportShell, exportJson]) {
      const redacted = exporter(state)
      for (const value of Object.values(values)) expect(redacted).not.toContain(value)
      expect(redacted).not.toContain('rpc.example.test')
      expect(redacted).not.toContain('archive.example.test')
      const included = exporter(state, { includeSensitiveValues: true })
      for (const [key, value] of Object.entries(values)) {
        if (exporter === exportYaml && key === 'BETTERSTACK_SOURCE_TOKEN') continue
        expect(included).toContain(value)
      }
    }
    const redactedEnvironment = await loadShellEnvironment(exportShell(state))
    for (const key of SENSITIVE_UI_KEYS) expect(redactedEnvironment[key]).toBe('<redacted>')
  })

  test('redacts sensitive values by default and includes them only with explicit opt-in', async () => {
    const state = createDefaultPlaygroundState()
    const privateKey = `0x${'9'.repeat(64)}`
    const sourceToken = 'super-private-source-token'
    state.scalar.MAKER_PRIVATE_KEY = privateKey
    state.observability.BETTERSTACK_SOURCE_TOKEN = sourceToken
    state.observability.BETTERSTACK_INGESTING_HOST = 'logs.example.test'

    const yamlRedacted = exportYaml(state)
    expect(yamlRedacted).not.toContain(privateKey)
    expect(yamlRedacted).not.toContain(sourceToken)
    expect(yamlRedacted).toContain('<redacted>')
    const yamlIncluded = exportYaml(state, { includeSensitiveValues: true })
    expect(yamlIncluded).toContain(privateKey)
    expect(yamlIncluded).not.toContain(sourceToken)

    for (const exporter of [exportShell, exportJson]) {
      const redacted = exporter(state)
      expect(redacted).not.toContain(privateKey)
      expect(redacted).not.toContain(sourceToken)
      expect(redacted).toContain('<redacted>')
      const included = exporter(state, { includeSensitiveValues: true })
      expect(included).toContain(privateKey)
      expect(included).toContain(sourceToken)
      expect(exporter(state)).not.toContain(privateKey)
    }
    const redactedEnvironment = await loadShellEnvironment(exportShell(state))
    expect(redactedEnvironment.MAKER_PRIVATE_KEY).toBe('<redacted>')
    expect(redactedEnvironment.BETTERSTACK_SOURCE_TOKEN).toBe('<redacted>')
  })

  test('builds ordered vertical geometry around center, gap, bounds, and relative rung sizes', () => {
    const state = createDefaultPlaygroundState()
    state.ladder[0]!.sizeSkewBps = '1000'
    const [graphic] = generateLadderGraphicModels(state)
    expect(graphic?.axis.minimumRateBps).toBe('200')
    expect(graphic?.axis.maximumRateBps).toBe('800')
    expect(graphic?.axis.referenceRateBps).toBe('500')
    expect(graphic?.axis.centerRateBps).toBe('500')
    expect(graphic?.rungs.map(rung => [rung.side, rung.rateBps])).toEqual([
      ['higher', '800'],
      ['higher', '700'],
      ['higher', '600'],
      ['lower', '400'],
      ['lower', '300'],
      ['lower', '200']
    ])
    expect(
      graphic?.rungs.every((rung, index, rows) => index === 0 || rung.y > rows[index - 1]!.y)
    ).toBe(true)
    expect(graphic?.rungs[0]!.allocationBarRatio).toBeGreaterThan(
      graphic?.rungs[2]!.allocationBarRatio ?? 1
    )
    expect(graphic?.rungs[3]!.allocationBarRatio).toBeLessThan(
      graphic?.rungs[5]!.allocationBarRatio ?? 0
    )
    expect(graphic?.gapBps).toBe('200')
  })

  test('annotates per-market interval, minimum effective cycle, and retained-center tolerance semantics', () => {
    const state = createDefaultPlaygroundState()
    const second = createDefaultLadder(`0x${'6'.repeat(64)}`)
    state.scalar.MARKET_IDS = `${state.scalar.MARKET_IDS},${second.marketId}`
    state.ladder[0]!.loopIntervalSeconds = '60'
    state.ladder[0]!.movementToleranceBps = '10'
    second.loopIntervalSeconds = '30'
    second.movementToleranceBps = '20'
    state.ladder.push(second)

    const cadence = generateLadderGraphicModels(state).map(
      model => model.callouts.find(callout => callout.label === 'Cadence & tolerance')?.value
    )
    expect(cadence).toEqual([
      '60s configured interval · 30s effective runtime cycle (minimum across configured markets) · 10 BPS informational deadband against retained active center; fresh stateless center unchanged',
      '30s configured interval · 30s effective runtime cycle (minimum across configured markets) · 20 BPS informational deadband against retained active center; fresh stateless center unchanged'
    ])
  })

  test('returns empty graphics for no markets and ordered models for multiple markets', () => {
    const state = createDefaultPlaygroundState()
    state.ladder = []
    expect(generateLadderGraphicModels(state)).toEqual([])

    const first = createDefaultLadder(`0x${'6'.repeat(64)}`)
    const second = createDefaultLadder(`0x${'5'.repeat(64)}`)
    state.scalar.MARKET_IDS = `${first.marketId},${second.marketId}`
    state.ladder = [first, second]
    expect(generateLadderGraphicModels(state).map(model => model.marketId)).toEqual([
      first.marketId,
      second.marketId
    ])
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

  test('matches runtime heartbeat classification without blocking core validation or exports', () => {
    const cases = [
      ['', 'disabled'],
      ['   ', 'disabled'],
      ['https://example.test/heartbeat', 'enabled'],
      ['http://user:pass@example.test:8080/heartbeat?maker=1#ok', 'enabled'],
      ['  HTTPS://example.test/heartbeat  ', 'enabled'],
      ['ftp://example.test/heartbeat', 'misconfigured'],
      ['file:///tmp/heartbeat', 'misconfigured'],
      ['ws://example.test/heartbeat', 'misconfigured'],
      ['javascript:alert(1)', 'misconfigured'],
      ['not a URL', 'misconfigured'],
      ['https://example.test:bad-port/heartbeat', 'misconfigured']
    ] as const

    for (const [heartbeat, expected] of cases) {
      const state = createDefaultPlaygroundState()
      state.observability.BETTERSTACK_HEARTBEAT_URL = heartbeat
      const production = validateProductionState(state)
      const heartbeatStatus = getObservabilityStatuses(state).find(
        status => status.integration === 'heartbeat'
      )
      expect(production.valid).toBe(true)
      const runtimeState = heartbeat.trim()
        ? parseHttpHeartbeatUrl(heartbeat)
          ? 'enabled'
          : 'misconfigured'
        : 'disabled'
      expect(heartbeatStatus?.state).toBe(runtimeState)
      expect(heartbeatStatus?.state).toBe(expected)
      for (const exporter of [exportYaml, exportShell, exportJson]) {
        expect(() => exporter(state)).not.toThrow()
      }
    }
  })

  test('matches shared runtime shipping classification for empty, partial, blank, and malformed pairs', () => {
    const cases = [
      ['', '', 'disabled'],
      ['   ', '   ', 'disabled'],
      ['token-secret', '', 'misconfigured'],
      ['', 'logs.example.test', 'misconfigured'],
      ['   ', 'logs.example.test', 'misconfigured'],
      ['token-secret', 'not a valid host', 'enabled']
    ] as const

    for (const [token, host, expected] of cases) {
      const state = createDefaultPlaygroundState()
      state.observability.BETTERSTACK_SOURCE_TOKEN = token
      state.observability.BETTERSTACK_INGESTING_HOST = host
      const runtime = classifyShippingConfig(productionEnvironment(state))
      const playground = getObservabilityStatuses(state).find(
        status => status.integration === 'shipping'
      )

      expect(runtime.state).toBe(expected)
      expect(playground?.state).toBe(runtime.state)
      expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
      expect(validatePreviewState(state)).toEqual({ valid: true, errors: [] })
      for (const exporter of [exportYaml, exportShell, exportJson]) {
        expect(() => exporter(state)).not.toThrow()
      }
      if (token.trim()) expect(JSON.stringify(playground)).not.toContain(token.trim())
      if (host) expect(JSON.stringify(playground)).not.toContain(host)
    }
  })

  test('keeps warning exports available, preserves env-only values, and redacts tokens by default', async () => {
    const state = createDefaultPlaygroundState()
    const token = 'warning-secret-token'
    const heartbeat = 'javascript:https://secret.example/heartbeat-token'
    state.observability.BETTERSTACK_SOURCE_TOKEN = token
    state.observability.BETTERSTACK_HEARTBEAT_URL = heartbeat

    expect(
      getObservabilityStatuses(state).filter(status => status.level === 'warning')
    ).toHaveLength(2)
    expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
    expect(validatePreviewState(state)).toEqual({ valid: true, errors: [] })

    const yaml = exportYaml(state)
    expect(yaml).not.toContain('BETTERSTACK_')
    expect(yaml).not.toContain(token)
    expect(yaml).not.toContain(heartbeat)

    const shell = exportShell(state)
    const shellEnvironment = await loadShellEnvironment(shell)
    expect(shellEnvironment.BETTERSTACK_SOURCE_TOKEN).toBe('<redacted>')
    expect(shellEnvironment.BETTERSTACK_INGESTING_HOST).toBe('')
    expect(shellEnvironment.BETTERSTACK_HEARTBEAT_URL).toBe(heartbeat)

    const json = JSON.parse(exportJson(state)) as {
      observability: Record<string, string>
    }
    expect(json.observability).toEqual({
      BETTERSTACK_SOURCE_TOKEN: '<redacted>',
      BETTERSTACK_INGESTING_HOST: '',
      BETTERSTACK_HEARTBEAT_URL: heartbeat
    })
    expect(exportShell(state, { includeSensitiveValues: true })).toContain(token)
    expect(exportJson(state, { includeSensitiveValues: true })).toContain(token)
  })

  test('matches ConfigService across accepted and rejected boundaries for all 17 scalar fields', () => {
    const validKey = `0x${'11'.repeat(32)}`
    const matrix = [
      ['CHAIN_ID', ' 8453 ', '8454'],
      ['RPC_URL', ' https://rpc.example/path/ ', 'not a url'],
      ['REFERENCE_RPC_URL', 'http://localhost:8545', '://missing-scheme'],
      ['MAKER_PRIVATE_KEY', ` ${validKey} `, `0x${'00'.repeat(32)}`],
      ['MAKER_ADDRESS', ` 0x${'1'.repeat(40)} `, '0x12'],
      ['MIDNIGHT_ADDRESS', `0x${'0'.repeat(40)}`, 'midnight'],
      ['LOAN_ASSET_ADDRESS', `0x${'3'.repeat(40)}`, '0x1234'],
      ['RATIFIER_ADDRESS', ` 0x${'4'.repeat(40)} `, 'ratifier'],
      ['MARKET_IDS', ` 0x${'5'.repeat(64)} `, '0x1234'],
      ['REFERENCE_MARKET_ID', ` 0x${'7'.repeat(64)} `, '0x1234'],
      ['NATIVE_RESERVE_WEI', '0', '-1'],
      ['MAXIMUM_LEND_EXPOSURE_ASSETS', '0', '1.5'],
      ['MORPHO_API_BASE_URL', 'http://localhost', 'not a url'],
      ['ROUTER_API_BASE_URL', 'https://router.example/', 'router host'],
      ['V0_OFFER_GROUP_IDS', ' , ', '0x1234'],
      ['REQUEST_TIMEOUT_MS', '120000', '120001'],
      ['TRANSACTION_RECEIPT_TIMEOUT_MS', '900000', '900001']
    ] as const

    expect(matrix.map(([field]) => field)).toEqual(SCALAR_FIELDS.map(([field]) => field))
    for (const [field, acceptedValue, rejectedValue] of matrix) {
      for (const [value, expected] of [
        [acceptedValue, true],
        [rejectedValue, false]
      ] as const) {
        const state = createDefaultPlaygroundState()
        state.scalar[field] = value
        expect({
          field,
          value,
          playground: validateProductionState(state).valid,
          production: productionAccepts(state)
        }).toEqual({ field, value, playground: expected, production: expected })
      }
    }
  })

  test('matches ConfigService acceptance of zero bigint setup boundaries', () => {
    for (const field of ['NATIVE_RESERVE_WEI', 'MAXIMUM_LEND_EXPOSURE_ASSETS'] as const) {
      const state = createDefaultPlaygroundState()
      state.scalar[field] = '0'
      expect(productionAccepts(state)).toBe(true)
      expect(validateProductionState(state).valid).toBe(true)
    }
  })

  test('accepts trimmed Base chain and zero bigint setup fields with canonical exports', async () => {
    const state = createDefaultPlaygroundState()
    state.scalar.CHAIN_ID = '  8453  '
    state.scalar.NATIVE_RESERVE_WEI = '0'
    state.scalar.MAXIMUM_LEND_EXPOSURE_ASSETS = '0'

    const production = validateWithProductionLoader(productionEnvironment(state))
    expect(production.setup).toMatchObject({
      chainId: 8453,
      nativeReserve: 0n,
      maximumLendExposure: 0n
    })
    expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
    expect(validatePreviewState(state)).toEqual({ valid: true, errors: [] })

    const yaml = exportYaml(state, { includeSensitiveValues: true })
    expect(yaml).toContain('  id: 8453\n')
    expect(yaml).toContain('  nativeReserveWei: "0"\n')
    expect(yaml).toContain('  maximumLendExposureAssets: "0"\n')
    const shellEnvironment = await loadShellEnvironment(
      exportShell(state, { includeSensitiveValues: true })
    )
    expect(shellEnvironment).toMatchObject({
      CHAIN_ID: '8453',
      NATIVE_RESERVE_WEI: '0',
      MAXIMUM_LEND_EXPOSURE_ASSETS: '0'
    })
    expect(validateWithProductionLoader(shellEnvironment).setup.chainId).toBe(8453)
    expect(
      JSON.parse(exportJson(state, { includeSensitiveValues: true })).configuration
    ).toMatchObject({
      CHAIN_ID: '8453',
      NATIVE_RESERVE_WEI: '0',
      MAXIMUM_LEND_EXPOSURE_ASSETS: '0'
    })
  })

  test.each([
    ['CHAIN_ID', '8454'],
    ['CHAIN_ID', '-1'],
    ['CHAIN_ID', '1.5'],
    ['CHAIN_ID', '9007199254740992'],
    ['NATIVE_RESERVE_WEI', '-1'],
    ['NATIVE_RESERVE_WEI', '1.5'],
    ['MAXIMUM_LEND_EXPOSURE_ASSETS', '-1'],
    ['MAXIMUM_LEND_EXPOSURE_ASSETS', '1.5']
  ] as const)(
    'matches production rejection and blocks preview/exports for %s=%s',
    (field, value) => {
      const state = createDefaultPlaygroundState()
      state.scalar[field] = value

      expect(productionAccepts(state)).toBe(false)
      expect(validateProductionState(state).valid).toBe(false)
      expect(validatePreviewState(state).valid).toBe(false)
      for (const exporter of [exportYaml, exportShell, exportJson]) {
        expect(() => exporter(state)).toThrow('Configuration is invalid')
      }
    }
  )

  test.each(['0', '-1'])(
    'treats non-positive preview reference rate %s as preview-only invalid like production adapter',
    async referenceRateBps => {
      const state = createDefaultPlaygroundState()
      const baselineExports = [
        exportYaml(state, { includeSensitiveValues: true }),
        exportShell(state, { includeSensitiveValues: true }),
        exportJson(state, { includeSensitiveValues: true })
      ]
      state.referenceRateBps = referenceRateBps

      expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
      expect(validatePreviewState(state)).toEqual({
        valid: false,
        errors: ['referenceRateBps must be positive']
      })
      const exports = [
        exportYaml(state, { includeSensitiveValues: true }),
        exportShell(state, { includeSensitiveValues: true }),
        exportJson(state, { includeSensitiveValues: true })
      ]
      expect(exports).toEqual(baselineExports)
      expect(
        validateWithProductionLoader(await loadShellEnvironment(exports[1]!)).ladder
      ).toHaveLength(1)
    }
  )

  test.each(['not-a-number', '1000000000000000000000000000000000000'])(
    'keeps all production exports valid when preview reference rate %s is invalid',
    async referenceRateBps => {
      const state = createDefaultPlaygroundState()
      state.referenceRateBps = referenceRateBps

      expect(validateProductionState(state)).toEqual({ valid: true, errors: [] })
      const preview = validatePreviewState(state)
      expect(preview.valid).toBe(false)
      expect(preview.errors.length).toBeGreaterThan(0)

      const yaml = exportYaml(state, { includeSensitiveValues: true })
      const shell = exportShell(state, { includeSensitiveValues: true })
      const json = exportJson(state, { includeSensitiveValues: true })
      expect(yaml).not.toContain(referenceRateBps)
      expect(shell).not.toContain(referenceRateBps)
      expect(json).not.toContain(referenceRateBps)
      expect(validateWithProductionLoader(await loadShellEnvironment(shell)).ladder).toHaveLength(1)
    }
  )

  test('genuine core errors still block exports and preview', () => {
    const state = createDefaultPlaygroundState()
    state.scalar.MAKER_PRIVATE_KEY = 'invalid'

    expect(validateProductionState(state).valid).toBe(false)
    expect(validatePreviewState(state).valid).toBe(false)
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

    const yaml = exportYaml(state, { includeSensitiveValues: true })
    const parsedYaml = parseDocument(yaml, { schema: 'failsafe' }).toJS() as {
      markets: { allowlist: unknown; v0OfferGroupIds: unknown }
    }
    expect(parsedYaml.markets.allowlist).toEqual([])
    expect(parsedYaml.markets.v0OfferGroupIds).toEqual([])

    const environment = await loadShellEnvironment(
      exportShell(state, { includeSensitiveValues: true })
    )
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

  test('YAML export round-trips hostile scalar content through the production loader without adding keys', async () => {
    const state = createDefaultPlaygroundState()
    const hostile = `https://example.test/  leading '"\\\t\r\nnewKey: injected # : $HOME $() \`backticks\`; trailing  /end`
    state.scalar.RPC_URL = hostile

    const yaml = exportYaml(state, { includeSensitiveValues: true })
    const document = parseDocument(yaml, { schema: 'failsafe', uniqueKeys: true })
    expect(document.errors).toEqual([])
    expect(document.warnings).toEqual([])
    const parsed = document.toJS() as Record<string, unknown> & {
      chain: { rpcUrl: string }
    }
    expect(parsed.chain.rpcUrl).toBe(hostile)
    expect(parsed.newKey).toBeUndefined()
    expect(Object.keys(parsed)).toEqual([
      'chain',
      'identity',
      'contracts',
      'apis',
      'markets',
      'setup',
      'bootstrap',
      'ladder'
    ])

    const cwd = '/tmp/morpho-playground-hostile-yaml-roundtrip'
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(`${cwd}/market-making.yaml`, yaml)
    const loaded = await ConfigService.load({}, { cwd, readOnly: true })
    expect(loaded.rpcUrl).toBe(hostile)
  })

  test('valid exports round-trip through real environment and YAML config loaders', async () => {
    const state = createDefaultPlaygroundState()
    const env = await loadShellEnvironment(exportShell(state, { includeSensitiveValues: true }))
    expect(validateWithProductionLoader(env).ladder).toHaveLength(1)

    const cwd = '/tmp/morpho-playground-roundtrip'
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(
      `${cwd}/market-making.yaml`,
      exportYaml(state, { includeSensitiveValues: true })
    )
    const loaded = await ConfigService.load({}, { cwd })
    expect(loaded.bootstrap).toHaveLength(1)
    expect(loaded.ladder).toHaveLength(1)
  })
})
