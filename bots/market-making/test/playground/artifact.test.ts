import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import ts from 'typescript'

import { productionPlaygroundBuildArguments } from '../../scripts/playground-build-arguments.mjs'

const packageRoot = join(import.meta.dir, '../..')
const PRODUCTION_ARTIFACT_GZIP_BUDGET_BYTES = 150 * 1024
const temporaryDirectories = new Set<string>()
const createOutdir = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'market-making-artifact-test-'))
  temporaryDirectories.add(directory)
  return directory
}
const runBuild = async (nodeEnv: string) => {
  const dist = await createOutdir()
  const process = Bun.spawn([Bun.which('bun')!, ...productionPlaygroundBuildArguments(dist)], {
    cwd: packageRoot,
    env: {
      ...Bun.env,
      NODE_ENV: nodeEnv,
      PRIVATE_KEY: 'artifact-private-key-canary',
      RPC_URL: 'https://artifact-secret.invalid'
    },
    stderr: 'pipe',
    stdout: 'pipe'
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text()
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  return dist
}
const normalizeHashedAssetName = (value: string) =>
  value.replace(/-[a-z0-9]{8}(?=\.[^./]+(?:$|["'?#)\s]))/g, '-[content-hash]')
const canonicalizeJavaScript = (source: string) => {
  const sourceFile = ts.createSourceFile(
    'production-artifact.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  expect(
    (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  ).toEqual([])
  const structure: (number | string)[] = []
  const visit = (node: ts.Node) => {
    structure.push(node.kind)
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.BigIntLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      structure.push((node as ts.LiteralLikeNode).text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return Buffer.from(JSON.stringify(structure))
}
const readArtifact = async (dist: string) => {
  const entries = await readdir(dist, { recursive: true, withFileTypes: true })
  const rawNames = entries
    .filter(entry => entry.isFile())
    .map(entry => relative(dist, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted()
  const entriesWithContents = await Promise.all(
    rawNames.map(async rawName => {
      const name = normalizeHashedAssetName(rawName)
      const contents = await readFile(join(dist, rawName))
      const text = /\.(?:html|css|js)$/.test(rawName)
        ? normalizeHashedAssetName(contents.toString('utf8'))
        : undefined
      const normalizedContents = rawName.endsWith('.js')
        ? canonicalizeJavaScript(text!)
        : text === undefined
          ? contents
          : Buffer.from(text)
      return {
        file: [name, normalizedContents] as const,
        gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
        text
      }
    })
  )
  const files = entriesWithContents.map(entry => entry.file)
  const names = files.map(([name]) => name).toSorted()
  expect(new Set(names).size).toBe(names.length)
  files.sort(([left], [right]) => left.localeCompare(right))
  const text = entriesWithContents.flatMap(entry => entry.text ?? []).join('\n')
  const gzipBytes = entriesWithContents.reduce((total, entry) => total + entry.gzipBytes, 0)
  return { files, gzipBytes, names, text }
}
const expectSameArtifact = (
  actual: Awaited<ReturnType<typeof readArtifact>>,
  expected: Awaited<ReturnType<typeof readArtifact>>
) => {
  expect(actual.names).toEqual(expected.names)
  expect(actual.files).toEqual(expected.files)
}

const expectProductionArtifact = (artifact: Awaited<ReturnType<typeof readArtifact>>) => {
  expect(
    artifact.gzipBytes,
    `production playground artifact is ${artifact.gzipBytes} gzip bytes; budget is ${PRODUCTION_ARTIFACT_GZIP_BUDGET_BYTES} bytes`
  ).toBeLessThanOrEqual(PRODUCTION_ARTIFACT_GZIP_BUDGET_BYTES)
  expect(artifact.names.some(name => name.endsWith('.map'))).toBe(false)
  const { text } = artifact
  expect(text).toContain('Minified React error')
  expect(text).not.toContain('react.development')
  expect(text).not.toContain('jsxDEV')
  expect(text).not.toContain('process.env.NODE_ENV')
  expect(text).not.toContain('sourceMappingURL')
  expect(text).not.toContain('artifact-private-key-canary')
  expect(text).not.toContain('artifact-secret.invalid')
  expect(text.split('\n').length).toBeLessThan(100)
}

describe('market-making playground production artifact', () => {
  afterEach(async () => {
    const directories = [...temporaryDirectories]
    temporaryDirectories.clear()
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  })

  test('is deterministic production/minified output without development branches, maps, or secrets', async () => {
    const first = await readArtifact(await runBuild('development'))
    const second = await readArtifact(await runBuild('production'))
    expectSameArtifact(second, first)
    expectProductionArtifact(first)

    for (let batch = 0; batch < 5; batch += 1) {
      const artifacts = await Promise.all(
        Array.from({ length: 4 }, async () => readArtifact(await runBuild('development')))
      )
      for (const artifact of artifacts) {
        expect(artifact.names).toEqual(first.names)
        expectProductionArtifact(artifact)
      }
    }
  }, 120_000)
})
