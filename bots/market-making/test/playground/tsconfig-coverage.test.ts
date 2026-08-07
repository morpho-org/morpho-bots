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

describe('market-making package TypeScript coverage', () => {
  test('includes the playground TSX entrypoint and rejects a type-error mutation in it', () => {
    const parsed = parsePackageConfig()
    expect(parsed.errors).toEqual([])
    expect(parsed.fileNames).toContain(appPath)

    const host = ts.createCompilerHost(parsed.options)
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const sourceFile = originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile
      )
      if (resolve(fileName) !== appPath || sourceFile === undefined) return sourceFile
      return ts.createSourceFile(
        fileName,
        `${sourceFile.text}\nconst tsconfigCoverageMutation: string = 1\n`,
        languageVersion,
        true,
        ts.ScriptKind.TSX
      )
    }

    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options, host)
    )
    expect(
      diagnostics.some(
        diagnostic =>
          diagnostic.file?.fileName === appPath &&
          ts
            .flattenDiagnosticMessageText(diagnostic.messageText, '\n')
            .includes("Type 'number' is not assignable to type 'string'")
      )
    ).toBe(true)
  }, 20_000)
})
