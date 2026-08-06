import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  CANONICAL_PUBLISH_TEMP_MARKER,
  publishCanonicalPlayground
} from './playground-atomic-publish.mjs'

const owned = new Set()
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const immediate = () => new Promise(resolve => setImmediate(resolve))
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'playground-content-publish-test-'))
  owned.add(root)
  await mkdir(join(root, 'playground'))
  return root
}
const makeTree = async (root, tag) => {
  const directory = await mkdtemp(join(root, '.dist.staging-'))
  const js = `globalThis.fixture=${JSON.stringify(tag)}`
  const css = `body{--fixture:${JSON.stringify(tag)}}`
  const jsName = `index.${hash(js)}.js`
  const cssName = `index.${hash(css)}.css`
  await mkdir(join(directory, 'assets'))
  await writeFile(
    join(directory, 'index.html'),
    `<link href="./assets/${cssName}"><script src="./assets/${jsName}"></script>`
  )
  await writeFile(join(directory, 'assets', jsName), js)
  await writeFile(join(directory, 'assets', cssName), css)
  return { css, cssName, directory, js, jsName, tag }
}
const readGeneration = async dist => {
  const html = await readFile(join(dist, 'index.html'), 'utf8')
  const names = [...html.matchAll(/assets\/(index\.[0-9a-f]{12}\.(?:js|css))/g)].map(
    match => match[1]
  )
  assert.equal(names.length, 2)
  await Promise.all(names.map(name => readFile(join(dist, 'assets', name))))
  return html
}
const assertNoTempDebris = async path => {
  const names = await readdir(path, { recursive: true })
  assert.deepEqual(
    names.filter(name => name.includes(CANONICAL_PUBLISH_TEMP_MARKER)),
    []
  )
}

async function publish(dist, tree, options = {}) {
  return publishCanonicalPlayground({ canonical: dist, staging: tree.directory, ...options })
}

afterEach(async () => {
  await Promise.all([...owned].map(path => rm(path, { recursive: true, force: true })))
  owned.clear()
})

test('index is gapless, old HTML remains fetchable, assets precede the new index, and old assets remain', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old')
  const next = await makeTree(root, 'next')
  await publish(dist, old)
  const oldHtml = await readFile(join(dist, 'index.html'), 'utf8')

  let reading = true
  let reads = 0
  const reader = (async () => {
    while (reading) {
      await readGeneration(dist) // Any ENOENT is a test failure: readers never retry publication gaps.
      reads += 1
      await immediate()
    }
  })()
  try {
    await publish(dist, next, {
      beforeIndexRename: async () => {
        // A client that fetched old HTML before publication can still fetch its assets.
        assert.equal(await readFile(join(dist, 'index.html'), 'utf8'), oldHtml)
        assert.equal(await readFile(join(dist, 'assets', old.jsName), 'utf8'), old.js)
        // Every asset referenced by the not-yet-visible new index is already canonical.
        assert.equal(await readFile(join(dist, 'assets', next.jsName), 'utf8'), next.js)
        assert.equal(await readFile(join(dist, 'assets', next.cssName), 'utf8'), next.css)
        await immediate()
      }
    })
  } finally {
    reading = false
    await reader
  }

  assert.ok(reads > 0)
  assert.match(await readGeneration(dist), new RegExp(next.jsName.replaceAll('.', '\\.')))
  assert.equal(await readFile(join(dist, 'assets', old.jsName), 'utf8'), old.js)
  await assertNoTempDebris(dist)
})

test('100 same/different concurrent publishers leave all observed generations fetchable', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old')
  await publish(dist, old)
  const trees = await Promise.all(
    Array.from({ length: 100 }, (_, index) => makeTree(root, index % 2 ? 'same' : `tag-${index}`))
  )

  let reading = true
  const observedHtml = new Set()
  const reader = (async () => {
    while (reading) {
      observedHtml.add(await readGeneration(dist))
      await immediate()
    }
  })()
  try {
    await Promise.all(trees.map(tree => publish(dist, tree)))
  } finally {
    reading = false
    await reader
  }

  observedHtml.add(await readGeneration(dist))
  for (const html of observedHtml) {
    for (const [, name] of html.matchAll(/assets\/(index\.[0-9a-f]{12}\.(?:js|css))/g)) {
      await readFile(join(dist, 'assets', name))
    }
  }
  for (const tree of [old, ...trees]) {
    assert.equal(await readFile(join(dist, 'assets', tree.jsName), 'utf8'), tree.js)
    assert.equal(await readFile(join(dist, 'assets', tree.cssName), 'utf8'), tree.css)
  }
  await assertNoTempDebris(dist)
})

test('failure injection at every pre-commit phase preserves old index and leaves no temp debris', async () => {
  const phases = [
    'canonical-ready',
    'asset-temp-open',
    'asset-write',
    'asset-fsync',
    'asset-close',
    'asset-publish',
    'asset-temp-remove',
    'assets-ready',
    'index-temp-open',
    'index-write',
    'index-fsync',
    'index-close',
    'before-index-rename'
  ]
  for (const phase of phases) {
    const root = await makeRoot()
    const dist = join(root, 'playground', 'dist')
    const old = await makeTree(root, `old-${phase}`)
    const next = await makeTree(root, `next-${phase}`)
    await publish(dist, old)
    const oldHtml = await readFile(join(dist, 'index.html'))
    let injected = false

    await assert.rejects(
      publish(dist, next, {
        afterStep(step) {
          if (!injected && step === phase) {
            injected = true
            throw new Error(`injected ${phase}`)
          }
        }
      }),
      new RegExp(`injected ${phase}`)
    )
    assert.ok(injected, `phase was reached: ${phase}`)
    assert.deepEqual(await readFile(join(dist, 'index.html')), oldHtml)
    await readGeneration(dist)
    await assertNoTempDebris(dist)
  }
})

test('a colliding hash name must contain identical bytes and invalid hashed assets publish nothing', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old')
  const next = await makeTree(root, 'next')
  await publish(dist, old)
  const oldHtml = await readFile(join(dist, 'index.html'))

  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'assets', next.jsName), 'different bytes')
  await assert.rejects(publish(dist, next), /immutable asset collision/)
  assert.deepEqual(await readFile(join(dist, 'index.html')), oldHtml)
  await assertNoTempDebris(dist)

  const invalid = await makeTree(root, 'invalid')
  await writeFile(join(invalid.directory, 'assets', 'not-hashed.js'), 'bad')
  await assert.rejects(publish(dist, invalid), /content-hashed JavaScript\/CSS/)
  assert.deepEqual(await readFile(join(dist, 'index.html')), oldHtml)
})

test('same immutable name with identical bytes is accepted, and symlink canonicals are rejected', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const sameA = await makeTree(root, 'same')
  const sameB = await makeTree(root, 'same')
  await publish(dist, sameA)
  await publish(dist, sameB)
  await readGeneration(dist)
  await assertNoTempDebris(dist)

  const outside = await mkdtemp(join(tmpdir(), 'playground-publish-outside-'))
  owned.add(outside)
  const linked = join(root, 'playground', 'linked-dist')
  await symlink(outside, linked)
  await assert.rejects(publish(linked, await makeTree(root, 'linked')), /non-symlink directory/)
})
