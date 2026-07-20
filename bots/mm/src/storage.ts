import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Registry } from './registry'

export function storagePaths(baseDir = Bun.env.MM_HOME ?? join(homedir(), '.mm')) {
  return {
    baseDir,
    registry: join(baseDir, 'registry.json'),
    makes: join(baseDir, 'makes'),
    cancels: join(baseDir, 'cancels')
  }
}

export async function readRegistry(path: string): Promise<Registry> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Registry
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, bigintReplacer, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}
