import { relative, resolve } from 'node:path'
import ts from 'typescript'

const packageRoot = resolve(import.meta.dir, '..')
const sourceRoot = resolve(packageRoot, 'src')
const sourceFiles = [
  'application/setup-check.service.ts',
  'bootstrap.ts',
  'config/config.service.ts',
  'infrastructure/cli/cli.ts',
  'infrastructure/setup-state/viem-setup-state.service.ts'
].map(path => resolve(sourceRoot, path))

const program = ts.createProgram(sourceFiles, {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
  strict: true
})

const failures: string[] = []
const checked: string[] = []

function isExported(node: ts.Node) {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function isPublic(node: ts.ClassElement) {
  if (!ts.canHaveModifiers(node)) return true
  const modifiers = ts.getModifiers(node)
  return !modifiers?.some(
    modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword
  )
}

function nameOf(node: ts.Node) {
  if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text
  }
  return ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>'
}

function hasJSDoc(sourceFile: ts.SourceFile, node: ts.Node) {
  return (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.some(doc => {
    const text = doc
      .getText(sourceFile)
      .replace('/**', '')
      .replace('*/', '')
      .replaceAll('*', '')
      .trim()
    return text.length >= 20
  })
}

function check(sourceFile: ts.SourceFile, node: ts.Node, qualifiedName: string) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const item = `${relative(packageRoot, sourceFile.fileName)}:${location.line + 1} ${qualifiedName}`
  checked.push(item)
  if (!hasJSDoc(sourceFile, node)) failures.push(item)
}

for (const sourceFile of program.getSourceFiles()) {
  if (!sourceFiles.includes(sourceFile.fileName)) continue

  sourceFile.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && isExported(node)) {
      check(sourceFile, node, `function ${nameOf(node)}`)
      if (node.type && ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isMethodSignature(member))
            check(sourceFile, member, `${nameOf(node)} return.${nameOf(member)}`)
        }
      }
      return
    }
    if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      check(sourceFile, node, `interface ${node.name.text}`)
      for (const member of node.members) {
        if (ts.isMethodSignature(member))
          check(sourceFile, member, `${node.name.text}.${nameOf(member)}`)
      }
      return
    }
    if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      check(sourceFile, node, `type ${node.name.text}`)
      if (ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isMethodSignature(member))
            check(sourceFile, member, `${node.name.text}.${nameOf(member)}`)
        }
      }
      return
    }
    if (ts.isClassDeclaration(node) && isExported(node) && node.name) {
      check(sourceFile, node, `class ${node.name.text}`)
      for (const member of node.members) {
        if (!isPublic(member)) continue
        if (
          ts.isConstructorDeclaration(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          check(sourceFile, member, `${node.name.text}.${nameOf(member)}`)
        }
      }
    }
  })
}

console.log(`JSDoc inventory (${checked.length} declarations):`)
for (const item of checked) console.log(`- ${item}`)

if (failures.length > 0) {
  console.error(`\nMissing substantive JSDoc (${failures.length} declarations):`)
  for (const item of failures) console.error(`- ${item}`)
  throw new Error(`JSDoc coverage failed for ${failures.length} declarations`)
}
