import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
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

test('symlink asset parents and immutable asset links are rejected without touching their targets', async () => {
  const root = await makeRoot()
  const outside = await mkdtemp(join(tmpdir(), 'playground-publish-target-'))
  owned.add(outside)
  const marker = join(outside, 'marker')
  await writeFile(marker, 'untouched')

  const linkedParentDist = join(root, 'playground', 'linked-parent-dist')
  await mkdir(linkedParentDist)
  await symlink(outside, join(linkedParentDist, 'assets'))
  await assert.rejects(
    publish(linkedParentDist, await makeTree(root, 'linked-parent')),
    /symlink|directory/
  )
  assert.equal(await readFile(marker, 'utf8'), 'untouched')
  assert.deepEqual(await readdir(outside), ['marker'])

  const linkedAssetDist = join(root, 'playground', 'linked-asset-dist')
  const linkedAssetTree = await makeTree(root, 'linked-asset')
  await mkdir(join(linkedAssetDist, 'assets'), { recursive: true })
  await symlink(marker, join(linkedAssetDist, 'assets', linkedAssetTree.jsName))
  await assert.rejects(publish(linkedAssetDist, linkedAssetTree), /symlink|regular file/)
  assert.equal(await readFile(marker, 'utf8'), 'untouched')

  const nonregularDist = join(root, 'playground', 'nonregular-asset-dist')
  const nonregularTree = await makeTree(root, 'nonregular-asset')
  await mkdir(join(nonregularDist, 'assets', nonregularTree.jsName), { recursive: true })
  await assert.rejects(publish(nonregularDist, nonregularTree), /regular file/)
})

test('exclusive publication temps are private regular files in their trusted canonical directories', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const tree = await makeTree(root, 'private-temps')
  const observedPrivate = []
  const observedFinal = []
  await publish(dist, tree, {
    afterStep: async (phase, detail) => {
      if (
        phase !== 'asset-temp-open' &&
        phase !== 'index-temp-open' &&
        phase !== 'asset-write' &&
        phase !== 'index-write' &&
        phase !== 'asset-fsync' &&
        phase !== 'index-fsync' &&
        phase !== 'asset-close' &&
        phase !== 'index-close'
      ) {
        return
      }
      const metadata = await lstat(detail.temp)
      assert.equal(metadata.isFile(), true)
      const isPrivatePhase = phase.endsWith('-open') || phase.endsWith('-write')
      if (process.platform !== 'win32') {
        assert.equal(metadata.mode & 0o777, isPrivatePhase ? 0o600 : 0o644)
      }
      ;(isPrivatePhase ? observedPrivate : observedFinal).push(detail.temp)
    }
  })
  assert.equal(observedPrivate.length, 6)
  assert.equal(observedFinal.length, 6)
  await assertNoTempDebris(dist)
})

test('final files are 0644 and publication directories are 0755 independent of umask', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const first = await makeTree(root, 'mode-normalization')
  const same = await makeTree(root, 'mode-normalization')
  const previousUmask = process.umask(0o077)
  try {
    await publish(dist, first)
    // An already-canonical identical asset is normalized too, rather than inheriting old metadata.
    await chmod(join(dist, 'assets', first.jsName), 0o600)
    await publish(dist, same)
  } finally {
    process.umask(previousUmask)
  }

  for (const directory of [dist, join(dist, 'assets')]) {
    assert.equal((await lstat(directory)).mode & 0o777, 0o755)
  }
  for (const file of [
    join(dist, 'index.html'),
    join(dist, 'assets', first.jsName),
    join(dist, 'assets', first.cssName)
  ]) {
    const metadata = await lstat(file)
    assert.equal(metadata.mode & 0o777, 0o644)
    assert.notEqual(metadata.mode & 0o004, 0, `${file} must be readable by a separate uid`)
  }
  await assertNoTempDebris(dist)
})

test('asset replacement, symlink substitution, and deletion after readiness reject the index commit', async () => {
  for (const attack of ['different-bytes', 'symlink', 'delete']) {
    const root = await makeRoot()
    const dist = join(root, 'playground', 'dist')
    const old = await makeTree(root, `old-${attack}`)
    const next = await makeTree(root, `next-${attack}`)
    await publish(dist, old)
    const oldHtml = await readFile(join(dist, 'index.html'))
    const oldJs = await readFile(join(dist, 'assets', old.jsName))
    const target = join(dist, 'assets', next.jsName)

    await assert.rejects(
      publish(dist, next, {
        beforeIndexRename: async () => {
          if (attack === 'different-bytes') await writeFile(target, 'attacker bytes')
          if (attack === 'symlink') {
            await unlink(target)
            await symlink(join(dist, 'assets', old.jsName), target)
          }
          if (attack === 'delete') await unlink(target)
        }
      }),
      /asset|regular file|ENOENT|identity|bytes|digest/i
    )
    assert.deepEqual(await readFile(join(dist, 'index.html')), oldHtml)
    assert.deepEqual(await readFile(join(dist, 'assets', old.jsName)), oldJs)
    await readGeneration(dist)
    await assertNoTempDebris(dist)
  }
})

test('asset parent identity replacement after readiness rejects the index commit', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old-asset-parent')
  const next = await makeTree(root, 'next-asset-parent')
  await publish(dist, old)
  const oldHtml = await readFile(join(dist, 'index.html'))
  const displaced = join(dist, 'assets-displaced')
  const marker = join(dist, 'assets', 'marker')

  await assert.rejects(
    publish(dist, next, {
      beforeIndexRename: async () => {
        await rename(join(dist, 'assets'), displaced)
        await mkdir(join(dist, 'assets'))
        await writeFile(marker, 'untouched')
      }
    }),
    /asset parent|asset directory|identity|replaced/i
  )
  assert.deepEqual(await readFile(join(dist, 'index.html')), oldHtml)
  assert.equal(await readFile(marker, 'utf8'), 'untouched')
  assert.equal(await readFile(join(displaced, old.jsName), 'utf8'), old.js)
  await assertNoTempDebris(dist)
})

test('canonical replacement before assets is rejected and replacement target is untouched', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old-replaced-before-assets')
  const next = await makeTree(root, 'next-replaced-before-assets')
  await publish(dist, old)
  const displaced = `${dist}-displaced`
  const marker = join(dist, 'marker')

  await assert.rejects(
    publish(dist, next, {
      afterStep: async phase => {
        if (phase !== 'canonical-ready') return
        await rename(dist, displaced)
        await mkdir(dist)
        await writeFile(marker, 'untouched')
      }
    }),
    /replaced|identity/
  )
  assert.equal(await readFile(marker, 'utf8'), 'untouched')
  assert.deepEqual(await readdir(dist), ['marker'])
})

test('canonical replacement immediately before index commit is rejected and replacement target is untouched', async () => {
  const root = await makeRoot()
  const dist = join(root, 'playground', 'dist')
  const old = await makeTree(root, 'old-replaced-before-index')
  const next = await makeTree(root, 'next-replaced-before-index')
  await publish(dist, old)
  const displaced = `${dist}-displaced`
  const marker = join(dist, 'marker')

  await assert.rejects(
    publish(dist, next, {
      beforeIndexRename: async () => {
        await rename(dist, displaced)
        await mkdir(dist)
        await writeFile(marker, 'untouched')
      }
    }),
    /replaced|identity/
  )
  assert.equal(await readFile(marker, 'utf8'), 'untouched')
  assert.deepEqual(await readdir(dist), ['marker'])
})
