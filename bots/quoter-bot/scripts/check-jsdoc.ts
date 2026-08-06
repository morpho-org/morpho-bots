import { relative, resolve } from 'node:path'
import ts from 'typescript'

import { JSDocValidationError } from './js-doc-validation.error'

type Rule = 'summary' | 'params' | 'returns' | 'throws' | 'concurrency' | 'deadline' | 'read-only'

/** One safe, deterministic documentation-contract violation. */
export type JSDocFailure = {
  file: string
  line: number
  declaration: string
  rule: Rule
  message: string
}

/** Complete public-declaration inventory and validation result for one TypeScript source. */
export type JSDocInspection = {
  declarations: string[]
  failures: JSDocFailure[]
}

const fillerSummary =
  /^(does the thing|handles? (it|things?)|todo|description|method|function)\.?$/i
const providerMethods = new Set([
  'ViemSetupStateService.getChainId',
  'ViemSetupStateService.getCode',
  'ViemSetupStateService.getNativeBalance',
  'ViemSetupStateService.getLoanAllowance',
  'ViemSetupStateService.getRatifier',
  'ViemSetupStateService.getBook',
  'ViemSetupStateService.getLatestTimestamp',
  'ViemSetupStateService.checkReference',
  'ViemSetupStateService.inspectOffers'
])
const concurrencyDeclarations = new Set([
  'SetupCheckService.check',
  'ViemSetupStateService.getRatifier',
  'ViemSetupStateService.getBook',
  'ViemSetupStateService.checkReference'
])
const deadlineDeclarations = new Set(['ViemSetupStateService.inspectOffers'])
const readOnlyDeclarations = new Set([
  'SetupCheckService.assertReady',
  'SetupCheckService.runContinuously',
  'SetupCheckService.check',
  ...providerMethods,
  'ViemSetupStateService.checkPositionHealth'
])

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true

const isPublic = (node: ts.ClassElement) => {
  if (!ts.canHaveModifiers(node)) return true
  const modifiers = ts.getModifiers(node)
  return !modifiers?.some(
    modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword
  )
}

const nameOf = (node: ts.Node) => {
  if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
    return (node.name as ts.Identifier).text
  }
  return ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>'
}

const callableParameters = (node: ts.Node): readonly ts.ParameterDeclaration[] => {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.parameters
  }
  return []
}

const callableType = (node: ts.Node) => {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node)
  ) {
    return node.type
  }
  return undefined
}

const jsDocFor = (node: ts.Node) => {
  const own = (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.at(-1)
  if (own) return own
  if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) {
    const statement = node.parent.parent.parent
    return (statement as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.at(-1)
  }
  return undefined
}

const commentText = (comment: string | ts.NodeArray<ts.JSDocComment> | undefined) => {
  if (typeof comment === 'string') return comment
  return comment?.map(part => ('text' in part ? part.text : '')).join('') ?? ''
}

const tagNames = (doc: ts.JSDoc, kind: ts.SyntaxKind) =>
  (doc.tags ?? [])
    .filter(tag => tag.kind === kind)
    .map(tag => (tag as ts.JSDocTag & { name?: ts.Node }).name?.getText() ?? '')

const hasTag = (doc: ts.JSDoc, kind: ts.SyntaxKind) =>
  (doc.tags ?? []).some(tag => tag.kind === kind)

const returnsValue = (node: ts.Node, sourceFile: ts.SourceFile) => {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isMethodSignature(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node) &&
    !ts.isConstructorDeclaration(node)
  ) {
    return false
  }
  if (ts.isConstructorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return false
  const type = callableType(node)?.getText(sourceFile)
  if (type) return type !== 'void' && type !== 'Promise<void>'
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return true
  if ('body' in node && node.body && ts.isBlock(node.body)) {
    return node.body.statements.some(
      statement => ts.isReturnStatement(statement) && statement.expression !== undefined
    )
  }
  return true
}

const returnsPromise = (node: ts.Node, sourceFile: ts.SourceFile) => {
  const type = callableType(node)?.getText(sourceFile) ?? ''
  return (
    type.includes('Promise<') ||
    (ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))
  )
}

const inspectCallable = (
  sourceFile: ts.SourceFile,
  node: ts.Node,
  declaration: string,
  file: string,
  failures: JSDocFailure[]
) => {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const fail = (rule: Rule, message: string) =>
    failures.push({ file, line, declaration, rule, message })
  const doc = jsDocFor(node)
  if (!doc) {
    fail('summary', 'missing JSDoc summary')
    return
  }

  const summary = commentText(doc.comment).replace(/\s+/g, ' ').trim()
  if (summary.length < 20 || fillerSummary.test(summary))
    fail('summary', 'summary is missing or filler')

  const expectedParams = callableParameters(node).flatMap(parameter =>
    ts.isIdentifier(parameter.name) ? [parameter.name.text] : []
  )
  const actualParams = tagNames(doc, ts.SyntaxKind.JSDocParameterTag)
  if (
    expectedParams.length !== actualParams.length ||
    expectedParams.some(parameter => !actualParams.includes(parameter)) ||
    actualParams.some(parameter => !expectedParams.includes(parameter))
  ) {
    fail('params', `@param tags must exactly match: ${expectedParams.join(', ') || '(none)'}`)
  }

  if (returnsValue(node, sourceFile) && !hasTag(doc, ts.SyntaxKind.JSDocReturnTag)) {
    fail('returns', 'non-void callable requires @returns')
  }

  const parentName = node.parent && 'name' in node.parent ? nameOf(node.parent) : ''
  const isPromiseInterfaceMethod =
    ts.isMethodSignature(node) &&
    returnsPromise(node, sourceFile) &&
    (parentName === 'ChainReader' || parentName === 'Reader')
  if (
    (isPromiseInterfaceMethod ||
      providerMethods.has(declaration) ||
      declaration === 'requestJson') &&
    !hasTag(doc, ts.SyntaxKind.JSDocThrowsTag)
  ) {
    fail('throws', 'provider or asynchronous interface boundary requires @throws')
  }

  const fullText = doc.getText(sourceFile).toLowerCase()
  if (concurrencyDeclarations.has(declaration) && !/promise\.all|concurren/.test(fullText)) {
    fail('concurrency', 'concurrent boundary must document Promise.all or concurrency')
  }
  if (
    deadlineDeclarations.has(declaration) &&
    !/absolute deadline|whole traversal|aggregate deadline/.test(fullText)
  ) {
    fail('deadline', 'pagination boundary must document its aggregate absolute deadline')
  }
  if (readOnlyDeclarations.has(declaration) && !/read-only|no writes|never .*writ/.test(fullText)) {
    fail('read-only', 'read boundary must document that it performs no writes')
  }
}

/**
 * Inventories exported callables and validates their substantive JSDoc contract.
 * @param file - Package-relative TypeScript filename used in safe diagnostics.
 * @param source - Complete TypeScript source text to parse without executing it.
 * @returns Every inspected declaration and every deterministic documentation-rule failure.
 * @remarks The inspection is read-only: it parses in memory and performs no filesystem writes.
 */
export const inspectJSDocSource = (file: string, source: string): JSDocInspection => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const declarations: string[] = []
  const failures: JSDocFailure[] = []
  const inspect = (node: ts.Node, declaration: string) => {
    declarations.push(declaration)
    inspectCallable(sourceFile, node, declaration, file, failures)
  }

  sourceFile.forEachChild(node => {
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isArrowFunction(declaration.initializer)
        ) {
          inspect(declaration.initializer, declaration.name.text)
        }
      }
      return
    }
    if (ts.isFunctionDeclaration(node) && isExported(node)) {
      inspect(node, `function ${nameOf(node)}`)
      return
    }
    if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      inspect(node, `interface ${node.name.text}`)
      for (const member of node.members) {
        if (ts.isMethodSignature(member)) inspect(member, `${node.name.text}.${nameOf(member)}`)
      }
      return
    }
    if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      inspect(node, `type ${node.name.text}`)
      if (ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isMethodSignature(member)) inspect(member, `${node.name.text}.${nameOf(member)}`)
        }
      }
      return
    }
    if (ts.isClassDeclaration(node) && isExported(node) && node.name) {
      inspect(node, `class ${node.name.text}`)
      for (const member of node.members) {
        if (!isPublic(member)) continue
        if (
          ts.isConstructorDeclaration(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          inspect(member, `${node.name.text}.${nameOf(member)}`)
        }
      }
    }
  })

  return { declarations, failures }
}

const packageRoot = resolve(import.meta.dir, '..')

/**
 * Discovers the TypeScript files that define the documented quoter-bot surface.
 * @param root - Absolute quoter-bot package directory to scan.
 * @returns Relevant source and checker files in deterministic package-relative order.
 * @remarks The scan is read-only and excludes the executable entrypoint and test files.
 */
export const discoverJSDocSourceFiles = async (root: string) => {
  const glob = new Bun.Glob('{src,scripts}/**/*.ts')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    const packagePath = relative(root, file)
    if (packagePath === 'src/index.ts' || packagePath.endsWith('.test.ts')) continue
    files.push(file)
  }
  return files.toSorted()
}

const run = async () => {
  const sourceFiles = await discoverJSDocSourceFiles(packageRoot)
  const failures: JSDocFailure[] = []
  const declarations: string[] = []
  for (const file of sourceFiles) {
    const source = await Bun.file(file).text()
    const inspection = inspectJSDocSource(relative(packageRoot, file), source)
    declarations.push(
      ...inspection.declarations.map(item => `${relative(packageRoot, file)} ${item}`)
    )
    failures.push(...inspection.failures)
  }

  console.log(`JSDoc inventory (${declarations.length} declarations):`)
  for (const item of declarations) console.log(`- ${item}`)
  if (failures.length > 0) {
    console.error(`\nJSDoc contract failures (${failures.length}):`)
    for (const failure of failures) {
      console.error(
        `- ${failure.file}:${failure.line} ${failure.declaration} [${failure.rule}] ${failure.message}`
      )
    }
    throw new JSDocValidationError(failures.length)
  }
}

if (import.meta.main) await run()
