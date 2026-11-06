import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const packageRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
const configPath = resolve(packageRoot, 'tsconfig.json')
const appPath = resolve(packageRoot, 'playground/app.tsx')

const parsePackageConfig = () => {
  const { config, error } = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  expect(error).toBeUndefined()
  return ts.parseJsonConfigFileContent(config, ts.sys, packageRoot, undefined, configPath)
}

describe('quoter-bot package TypeScript coverage', () => {
  test('type-checks the playground TSX entrypoint with the package', () => {
    const parsed = parsePackageConfig()
    expect(parsed.errors).toEqual([])
    expect(parsed.fileNames).toContain(appPath)
    expect(parsed.options.noCheck).toBeUndefined()
  })
})
