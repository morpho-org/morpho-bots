import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  CUSTOM_OUTDIR_PREFIX,
  revalidatePlaygroundOutdir,
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
    const validated = await validate(packageRoot, custom)
    assert.equal(validated.canonical, false)
    assert.equal(validated.outdir, custom)
    assert.equal(validated.identity.realpath, custom)
    assert.equal(typeof validated.identity.dev, 'number')
    assert.equal(typeof validated.identity.ino, 'number')
  })

  test('custom output must be empty, direct, private, and have an exact owned prefix', async () => {
    const packageRoot = await temporaryDirectory('market-making-package-')
    await mkdir(join(packageRoot, 'playground'), { recursive: true })
    const nonempty = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)
    await writeFile(join(nonempty, 'entry'), 'not empty')
    const nested = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)
    await mkdir(join(nested, 'nested'))
    const wrongMode = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)
    if (process.platform !== 'win32') await chmod(wrongMode, 0o755)
    const wrongPrefix = await temporaryDirectory(`x${CUSTOM_OUTDIR_PREFIX}`)

    await assert.rejects(validate(packageRoot, nonempty), /empty/)
    await assert.rejects(validate(packageRoot, nested), /empty/)
    await assert.rejects(validate(packageRoot, wrongPrefix), /direct .* directory/)
    if (process.platform !== 'win32') {
      await assert.rejects(validate(packageRoot, wrongMode), /mode 0700/)
    }
  })

  test('revalidation detects replacement after initial validation', async () => {
    const packageRoot = await temporaryDirectory('market-making-package-')
    await mkdir(join(packageRoot, 'playground'), { recursive: true })
    const custom = await temporaryDirectory(CUSTOM_OUTDIR_PREFIX)
    const validated = await validate(packageRoot, custom)
    await rm(custom, { recursive: true })
    await mkdir(custom, { mode: 0o700 })

    await assert.rejects(revalidatePlaygroundOutdir(validated), /replaced/)
  })
})
