import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MUTATIONS } from './mutations'

const packageDir = path.resolve(import.meta.dirname, '..')
const REDUCER = 'src/kernel.ts'

const runTraces = (dir: string) =>
  spawnSync(path.join(packageDir, 'node_modules/.bin/vitest'), ['run', '--root', dir], {
    cwd: dir,
    encoding: 'utf8'
  }).status === 0

const copyPackage = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kernel-mutate-'))
  for (const entry of ['src', 'test', 'package.json', 'tsconfig.json', 'vitest.config.ts']) {
    cpSync(path.join(packageDir, entry), path.join(dir, entry), { recursive: true })
  }
  symlinkSync(path.join(packageDir, 'node_modules'), path.join(dir, 'node_modules'))
  return dir
}

const dir = copyPackage()
try {
  const original = readFileSync(path.join(dir, REDUCER), 'utf8')
  if (!runTraces(dir)) throw new Error('the traces fail without any mutation')
  const survivors: string[] = []
  const apply = (text: string, edit: Readonly<{ find: string; replace: string }>) =>
    text.split(edit.find).length === 2 ? text.replace(edit.find, edit.replace) : undefined
  const caughtWith = (text: string) => {
    writeFileSync(path.join(dir, REDUCER), text)
    return !runTraces(dir)
  }
  const only = process.env.MUTATION
  const chosen = MUTATIONS.filter(({ id }) => only === undefined || id === only)
  for (const mutation of chosen) {
    const mutated = apply(original, mutation)
    const cover = mutation.coveredBy
    const covered = cover && mutated !== undefined ? apply(mutated, cover) : undefined
    if (mutated === undefined || (cover && covered === undefined)) {
      console.log(`UNMATCHED ${mutation.id}`)
      survivors.push(mutation.id)
    } else if (caughtWith(mutated)) {
      console.log(`caught   ${mutation.id}`)
    } else if (covered !== undefined && caughtWith(covered)) {
      console.log(`covered  ${mutation.id}`)
    } else {
      console.log(`SURVIVED ${mutation.id}`)
      survivors.push(mutation.id)
    }
  }
  console.log(`${chosen.length - survivors.length} of ${chosen.length} mutations caught or covered`)
  if (survivors.length > 0) process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
