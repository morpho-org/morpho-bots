import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const packageRoot = join(import.meta.dir, '../..')
const PRODUCTION_ARTIFACT_GZIP_BUDGET_BYTES = 132 * 1024
const temporaryDirectories = new Set<string>()
const runBuild = async (nodeEnv: string) => {
  const buildProcess = Bun.spawn(
    [Bun.which('node')!, join(packageRoot, 'scripts/playground-build.mjs'), '--temporary'],
    {
      cwd: packageRoot,
      env: {
        ...Bun.env,
        BUN_EXE: Bun.which('bun')!,
        NODE_ENV: nodeEnv,
        PRIVATE_KEY: 'artifact-private-key-canary',
        RPC_URL: 'https://artifact-secret.invalid'
      },
      stderr: 'pipe',
      stdout: 'pipe'
    }
  )
  const [exitCode, stderr, stdout] = await Promise.all([
    buildProcess.exited,
    new Response(buildProcess.stderr).text(),
    new Response(buildProcess.stdout).text()
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  const records = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        const value = JSON.parse(line)
        return value?.kind === 'market-making-playground-build' && value?.mode === 'temporary'
          ? [value]
          : []
      } catch {
        return []
      }
    })
  expect(records).toHaveLength(1)
  expect(Object.keys(records[0]).toSorted()).toEqual(['kind', 'mode', 'path'])
  const dist = records[0].path as string
  temporaryDirectories.add(dist)
  return dist
}
const readArtifact = async (dist: string) => {
  const entries = await readdir(dist, { recursive: true, withFileTypes: true })
  const rawNames = entries
    .filter(entry => entry.isFile())
    .map(entry => relative(dist, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted()
  const entriesWithContents = await Promise.all(
    rawNames.map(async rawName => {
      const contents = await readFile(join(dist, rawName))
      const text = /\.(?:html|css|js)$/.test(rawName) ? contents.toString('utf8') : undefined
      return {
        file: [rawName, contents] as const,
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
  const treeHash = createHash('sha256')
  for (const [name, contents] of files) {
    treeHash.update(`${name.length}:${name}:${contents.byteLength}:`)
    treeHash.update(contents)
  }
  return { files, gzipBytes, names, text, treeHash: treeHash.digest('hex') }
}
const expectSameArtifact = (
  actual: Awaited<ReturnType<typeof readArtifact>>,
  expected: Awaited<ReturnType<typeof readArtifact>>
) => {
  expect(actual.names).toEqual(expected.names)
  expect(actual.files).toEqual(expected.files)
  expect(actual.treeHash).toBe(expected.treeHash)
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
  expect(text).not.toContain('@tanstack/devtools-event-client')
  expect(text).not.toContain('FormEventClient')
  expect(text).not.toContain('tanstack-connect')
  expect(text).not.toContain('form-devtools')
  expect(text.split('\n').length).toBeLessThan(100)
  const html = artifact.files.find(([name]) => name === 'index.html')?.[1].toString('utf8')
  expect(html).toBeDefined()
  for (const [name, contents] of artifact.files.filter(([name]) => /\.(?:css|js)$/.test(name))) {
    const match = name.match(/\.([0-9a-f]{12})\.(?:css|js)$/)
    expect(match, `${name} must have a content hash`).not.toBeNull()
    expect(match?.[1]).toBe(createHash('sha256').update(contents).digest('hex').slice(0, 12))
    expect(html).toContain(`./${name}`)
  }
  expect(html).not.toMatch(/\.\/(?:index|chunk)\.(?:css|js)/)
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

    for (let batch = 0; batch < 10; batch += 1) {
      const artifacts = await Promise.all(
        Array.from({ length: 5 }, async () => readArtifact(await runBuild('development')))
      )
      for (const artifact of artifacts) {
        expectSameArtifact(artifact, first)
        expectProductionArtifact(artifact)
      }
    }
  }, 300_000)
})
