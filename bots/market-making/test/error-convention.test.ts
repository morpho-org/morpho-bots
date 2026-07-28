import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import ts from 'typescript'

const packageRoot = join(import.meta.dir, '..')
const roots = [join(packageRoot, 'src'), join(packageRoot, 'scripts')]
const sourceFiles = roots.flatMap(root => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : extname(path) === '.ts' ? [path] : []
    })
  return walk(root)
})
const kebab = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()

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

describe('market-making error convention', () => {
  test('keeps each exported Error subclass alone in its matching kebab-case error file', () => {
    const failures: string[] = []
    for (const file of sourceFiles) {
      const { source, errorClasses } = inspect(file)
      for (const declaration of errorClasses) {
        const name = declaration.name?.text ?? '<anonymous>'
        const exported = declaration.modifiers?.some(
          modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
        if (!exported) failures.push(`${relative(packageRoot, file)}: ${name} is not exported`)
        const expected = `${kebab(name.replace(/Error$/, ''))}.error.ts`
        if (basename(file) !== expected) {
          failures.push(`${relative(packageRoot, file)}: ${name} must live in ${expected}`)
        }
      }
      if (file.endsWith('.error.ts')) {
        if (errorClasses.length !== 1) {
          failures.push(`${relative(packageRoot, file)}: expected exactly one Error subclass`)
        }
        const runtimeDeclarations = source.statements.filter(
          statement =>
            !ts.isImportDeclaration(statement) &&
            !ts.isImportEqualsDeclaration(statement) &&
            !ts.isInterfaceDeclaration(statement) &&
            !ts.isTypeAliasDeclaration(statement) &&
            !ts.isClassDeclaration(statement) &&
            !ts.isEmptyStatement(statement)
        )
        if (runtimeDeclarations.length > 0) {
          failures.push(
            `${relative(packageRoot, file)}: error files may not contain runtime helpers`
          )
        }
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
})
