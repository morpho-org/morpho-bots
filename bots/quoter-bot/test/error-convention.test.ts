import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const roots = [join(packageRoot, 'src'), join(packageRoot, 'scripts')]
const sourceFiles = roots.flatMap(root => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : extname(path) === '.ts' ? [path] : []
    })
  return walk(root)
})
const inspect = (file: string) => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const errorClasses: ts.ClassDeclaration[] = []
  const plainErrors: number[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isClassDeclaration(node) &&
      node.heritageClauses?.some(clause =>
        clause.types.some(type => type.expression.getText(source) === 'Error')
      )
    ) {
      errorClasses.push(node)
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error'
    ) {
      plainErrors.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { source, errorClasses, plainErrors }
}

describe('quoter-bot error convention', () => {
  test('exports every Error subclass', () => {
    const failures: string[] = []
    for (const file of sourceFiles) {
      for (const declaration of inspect(file).errorClasses) {
        const name = declaration.name?.text ?? '<anonymous>'
        const exported = declaration.modifiers?.some(
          modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
        if (!exported) failures.push(`${relative(packageRoot, file)}: ${name} is not exported`)
      }
    }
    expect(failures).toEqual([])
  })

  test('uses named typed errors for every expected production failure path', () => {
    const failures = sourceFiles.flatMap(file =>
      inspect(file).plainErrors.map(line => `${relative(packageRoot, file)}:${line}`)
    )
    expect(failures).toEqual([])
  })

  test('does not propagate raw Commander failures into CLI usage errors', () => {
    const cli = readFileSync(join(packageRoot, 'src/infrastructure/cli/cli.ts'), 'utf8')
    const errors = inspect(join(packageRoot, 'src/errors.ts'))
    const error = errors.errorClasses
      .find(declaration => declaration.name?.text === 'CliUsageError')
      ?.getText(errors.source)

    expect(cli).not.toMatch(/new CliUsageError\([^)]*error\.message/s)
    expect(cli).not.toMatch(/new CliUsageError\([^)]*cause/s)
    expect(error).not.toMatch(/ErrorOptions|readonly command|message: string|super\([^)]*,/)
  })
})
