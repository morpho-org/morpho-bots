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
  const originals = new Map<string, string>()
  const originalOf = (file: string) => {
    if (!originals.has(file)) originals.set(file, readFileSync(path.join(dir, file), 'utf8'))
    return originals.get(file)!
  }
  if (!runTraces(dir)) throw new Error('the traces fail without any mutation')
  const survivors: string[] = []
  const apply = (text: string, edit: Readonly<{ find: string; replace: string }>) =>
    text.split(edit.find).length === 2 ? text.replace(edit.find, edit.replace) : undefined
  const caughtWith = (file: string, text: string) => {
    writeFileSync(path.join(dir, file), text)
    const caught = !runTraces(dir)
    writeFileSync(path.join(dir, file), originalOf(file))
    return caught
  }
  const only = process.env.MUTATION
  const chosen = MUTATIONS.filter(({ id }) => only === undefined || id === only)
  for (const mutation of chosen) {
    const file = mutation.file ?? REDUCER
    const mutated = apply(originalOf(file), mutation)
    const cover = mutation.coveredBy
    const covered = cover && mutated !== undefined ? apply(mutated, cover) : undefined
    if (mutated === undefined || (cover && covered === undefined)) {
      console.log(`UNMATCHED ${mutation.id}`)
      survivors.push(mutation.id)
    } else if (caughtWith(file, mutated)) {
      console.log(`caught   ${mutation.id}`)
    } else if (covered !== undefined && caughtWith(file, covered)) {
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
