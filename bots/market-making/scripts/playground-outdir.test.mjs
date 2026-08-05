import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  CUSTOM_OUTDIR_PREFIX,
  cleanCanonicalPlaygroundOutdir,
  validatePlaygroundOutdir
} from './playground-outdir.mjs'

const owned = new Set()
const temporaryDirectory = async prefix => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  owned.add(directory)
  return directory
}
const validate = (packageRoot, requestedOutdir) =>
  validatePlaygroundOutdir({ packageRoot, requestedOutdir })

describe('production playground output confinement', () => {
  afterEach(async () => {
    await Promise.all([...owned].map(path => rm(path, { force: true, recursive: true })))
    owned.clear()
  })

  test('rejects roots, package/source paths, absent custom paths, wrong prefixes, and symlinks', async () => {
    const packageRoot = await temporaryDirectory('market-making-package-')
    await mkdir(join(packageRoot, 'playground', 'src'), { recursive: true })
    const outside = await temporaryDirectory('not-a-playground-output-')
    const validTarget = await temporaryDirectory(`${CUSTOM_OUTDIR_PREFIX}target-`)
    const link = join(tmpdir(), `${CUSTOM_OUTDIR_PREFIX}symlink-${crypto.randomUUID()}`)
    await symlink(validTarget, link)
    owned.add(link)

    for (const rejected of [
      '.',
      packageRoot,
      join(packageRoot, 'playground'),
      join(packageRoot, 'playground', 'src'),
      join(packageRoot, 'playground', 'src', 'nested'),
      outside,
      join(tmpdir(), `${CUSTOM_OUTDIR_PREFIX}absent-${crypto.randomUUID()}`),
      link
    ]) {
      await assert.rejects(validate(packageRoot, rejected))
    }
  })

  test('accepts only canonical or pre-created owned direct temporary outputs', async () => {
    const packageRoot = await temporaryDirectory('market-making-package-')
    await mkdir(join(packageRoot, 'playground'), { recursive: true })
    const custom = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)

    assert.deepEqual(await validate(packageRoot, 'playground/dist'), {
      canonical: true,
      outdir: join(packageRoot, 'playground', 'dist')
    })
    assert.deepEqual(await validate(packageRoot, custom), { canonical: false, outdir: custom })
  })

  test('concurrent canonical cleanup cannot remove or modify caller-owned temporary output', async () => {
    const packageRoot = await temporaryDirectory('market-making-package-')
    const canonical = join(packageRoot, 'playground', 'dist')
    const custom = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)
    await mkdir(canonical, { recursive: true })
    await writeFile(join(canonical, 'canonical-marker'), 'canonical')
    await writeFile(join(custom, 'caller-marker'), 'caller-owned')

    const [canonicalResult, customResult] = await Promise.all([
      validate(packageRoot, canonical).then(async result => {
        await cleanCanonicalPlaygroundOutdir(result.outdir)
        return result
      }),
      validate(packageRoot, custom)
    ])

    assert.equal(canonicalResult.outdir, canonical)
    assert.deepEqual(customResult, { canonical: false, outdir: custom })
    assert.equal(await readFile(join(custom, 'caller-marker'), 'utf8'), 'caller-owned')
    await assert.rejects(access(join(canonical, 'canonical-marker')))
  })
})
