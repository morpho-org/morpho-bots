import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FRAMEWORK = 'framework'
const ENFORCE_EVIDENCE = true

const EXEMPT_SECTIONS = new Set(['What is deliberately left out', 'Residual risks', 'Traces'])
const EVIDENCE_MARKERS = ['(untested)', '(review)']
const TEST_CALLEES = new Set(['it', 'test', 'describe'])
const TEST_SOURCE = /\.tsx?$/

/** `(§6, "Fees")` or `(ADR-2026-09-30, "A bot's key ...")` names a section or a decision, not a test. */
const REFERENCE = /(?:§[\d.]+|ADR-[\d-]+),\s*$/
/** Outside parentheses, only a sentence led by this word cites tests: `Traces: "a", "b".` */
const TRACE_LEAD = /\btraces?\b:?\s*$/i
const DESCRIBE_JOIN = /^\s*:\s*$/
const CASES_LEAD = /^\s*(?:cases:|for each of)\s*$/
const LIST_SEPARATOR = /^\s*(?:,|,?\s*and|or)\s*$/
const ELLIPSIS = /(?:…|\.\.\.)$/

type Title = Readonly<{
  /** For an `.each` title or a `${}` template, only the literal text before its first placeholder. */
  text: string
  raw: string
  /** Set only on an `.each` title: the case names its table yields, empty when unreadable. */
  cases: ReadonlySet<string> | undefined
  describe: boolean
  start: number
  end: number
}>

type TestFile = readonly Title[]

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Modifiers that return the test function itself after a call: `.each(table)`, `.skipIf(c)`. */
const CALLED_MODIFIERS = new Set(['each', 'skipIf', 'runIf'])
/** A title under one of these never runs, so it is no evidence. */
const NOT_RUN = new Set(['skip', 'todo'])

type Callee = Readonly<{ name: string; modifiers: readonly string[]; table?: ts.Expression }>

const calleeOf = (expression: ts.Expression): Callee | undefined => {
  if (ts.isIdentifier(expression)) return { name: expression.text, modifiers: [] }
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = calleeOf(expression.expression)
    return inner && { ...inner, modifiers: [...inner.modifiers, expression.name.text] }
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    CALLED_MODIFIERS.has(expression.expression.name.text)
  ) {
    const inner = calleeOf(expression.expression)
    const table = expression.expression.name.text === 'each' ? expression.arguments[0] : undefined
    return inner && { ...inner, ...(table && { table }) }
  }
  return undefined
}

const vitestCallees = (file: ts.SourceFile) => {
  const callees = new Map<string, string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const bindings = statement.importClause?.namedBindings
    if (statement.moduleSpecifier.text !== 'vitest' || !bindings || !ts.isNamedImports(bindings))
      continue
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (TEST_CALLEES.has(imported)) callees.set(element.name.text, imported)
    }
  }
  return callees
}

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isAsExpression(expression) ||
  ts.isSatisfiesExpression(expression) ||
  ts.isParenthesizedExpression(expression)
    ? unwrap(expression.expression)
    : expression

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? normalize(node.text)
    : undefined

const initializers = (file: ts.SourceFile) => {
  const found = new Map<string, ts.Expression | undefined>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      found.set(node.name.text, found.has(node.name.text) ? undefined : node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The row fields an `.each` title renders, per https://vitest.dev/api/#test-each. */
const PRINTF = /%%|%[sdijopf#]/g
const FIELD = /\$(\w+)/g

type Rendered = Readonly<{ columns: number; fields: ReadonlySet<string> }>

const renderedBy = (title: string): Rendered => ({
  columns: [...title.matchAll(PRINTF)].filter(([match]) => match !== '%%').length,
  fields: new Set([...title.matchAll(FIELD)].map(([, field]) => field!))
})

const rendersColumn = (rendered: Rendered, index: number) =>
  index < rendered.columns || rendered.fields.has(String(index))

const propertyName = (property: ts.ObjectLiteralElementLike) =>
  property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined

const rowCases = (element: ts.Expression, rendered: Rendered) => {
  const row = unwrap(element)
  if (ts.isArrayLiteralExpression(row))
    return row.elements.flatMap((item, index) =>
      rendersColumn(rendered, index) ? (literalText(item) ?? []) : []
    )
  if (ts.isObjectLiteralExpression(row))
    return row.properties.flatMap(property => {
      const name = propertyName(property)
      return name !== undefined && rendered.fields.has(name) && ts.isPropertyAssignment(property)
        ? (literalText(property.initializer) ?? [])
        : []
    })
  return rendersColumn(rendered, 0) ? (literalText(row) ?? []) : []
}

/**
 * The case names an `.each` table yields: only the row values its title renders, from an inline or
 * named array, or the keys of an object read through `Object.entries`/`Object.keys`.
 */
const casesOf = (
  table: ts.Expression,
  named: ReadonlyMap<string, ts.Expression | undefined>,
  rendered: Rendered
): string[] => {
  const node = unwrap(table)
  if (ts.isIdentifier(node)) {
    const initializer = named.get(node.text)
    return initializer ? casesOf(initializer, new Map(), rendered) : []
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap(element => rowCases(element, rendered))
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === 'Object' &&
    ['entries', 'keys'].includes(node.expression.name.text) &&
    node.arguments[0] &&
    rendersColumn(rendered, 0)
  ) {
    const target = unwrap(node.arguments[0])
    const object = ts.isIdentifier(target) ? named.get(target.text) : target
    const literal = object && unwrap(object)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return []
    return literal.properties.flatMap(property => {
      const name = propertyName(property)
      return name === undefined ? [] : [normalize(name)]
    })
  }
  return []
}

const titleText = (node: ts.Expression | undefined) => {
  if (node === undefined) return undefined
  if (ts.isTemplateExpression(node))
    return { text: node.head.text, raw: node.getText().slice(1, -1) }
  const text = literalText(node)
  return text === undefined ? undefined : { text, raw: text }
}

/** Titles of run `it`/`test`/`describe` calls imported from vitest, read from the syntax tree. */
const testFile = (source: string): TestFile => {
  const file = ts.createSourceFile(
    'test.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const callees = vitestCallees(file)
  const named = initializers(file)
  const titles: Title[] = []
  const visit = (node: ts.Node) => {
    const callee = ts.isCallExpression(node) ? calleeOf(node.expression) : undefined
    const imported = callee && callees.get(callee.name)
    const title = ts.isCallExpression(node) ? titleText(node.arguments[0]) : undefined
    if (imported && callee.modifiers.some(m => NOT_RUN.has(m))) return
    if (imported && title) {
      const each = callee.modifiers.includes('each')
      const placeholder = each ? title.text.search(/[%$]/) : -1
      titles.push({
        text: normalize(placeholder === -1 ? title.text : title.text.slice(0, placeholder)),
        raw: normalize(title.raw),
        cases: each
          ? new Set(callee.table ? casesOf(callee.table, named, renderedBy(title.raw)) : [])
          : undefined,
        describe: imported === 'describe',
        start: node.getStart(),
        end: node.getEnd()
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return titles
}

const startsTitle = (quote: string, title: Title) =>
  quote !== '' && (title.text.startsWith(quote) || title.raw === quote)

type Citation = Readonly<{
  quote: string
  offset: number
  resolves: (files: readonly TestFile[]) => boolean
}>

const plain = (quote: string) => (files: readonly TestFile[]) =>
  files.some(titles => titles.some(title => startsTitle(quote, title)))

const nested = (outer: string, inner: string) => (files: readonly TestFile[]) =>
  files.some(titles =>
    titles.some(
      block =>
        block.describe &&
        startsTitle(outer, block) &&
        titles.some(
          title => title.start > block.start && title.end < block.end && startsTitle(inner, title)
        )
    )
  )

const eachCase = (each: string, name: string) => (files: readonly TestFile[]) =>
  files.some(titles =>
    titles.some(title => startsTitle(each, title) && title.cases?.has(name) === true)
  )

type Quote = Readonly<{ text: string; start: number; end: number }>

/**
 * Reads the citations in one run of quotes: `"a", "b"`; a describe joined to a nested title,
 * `"block": "title"`; and an `.each` title with its case names, `"title" cases: "x", "y"` or
 * `"title" for each of "x", "y"`.
 */
const citationsIn = (text: string, quotes: readonly Quote[], regionStart: number) => {
  const citations: Citation[] = []
  const between = (k: number) => text.slice(quotes[k]!.end, quotes[k + 1]?.start ?? quotes[k]!.end)
  for (let k = 0; k < quotes.length; k++) {
    const quote = quotes[k]!
    const before = text.slice(k === 0 ? regionStart : quotes[k - 1]!.end, quote.start)
    if (REFERENCE.test(before)) continue
    const next = quotes[k + 1]
    if (next && DESCRIBE_JOIN.test(between(k))) {
      citations.push({
        quote: `${quote.text}: ${next.text}`,
        offset: quote.start,
        resolves: nested(quote.text, next.text)
      })
      k++
    } else if (next && CASES_LEAD.test(between(k))) {
      citations.push({ quote: quote.text, offset: quote.start, resolves: plain(quote.text) })
      do {
        k++
        const name = quotes[k]!
        citations.push({
          quote: name.text,
          offset: name.start,
          resolves: eachCase(quote.text, name.text)
        })
      } while (k + 1 < quotes.length && LIST_SEPARATOR.test(between(k)))
    } else {
      citations.push({ quote: quote.text, offset: quote.start, resolves: plain(quote.text) })
    }
  }
  return citations
}

const CODE_SPAN = /`[^`]*`/g
const QUOTE = /"[^"]*"/g
const SENTENCE_END = /\.(?:\s|$)|\(/g

const blank = (match: string) => ' '.repeat(match.length)

const parenRegions = (bare: string) => {
  const regions: { start: number; end: number }[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === '(' && depth++ === 0) start = i + 1
    else if (bare[i] === ')' && depth > 0 && --depth === 0) regions.push({ start, end: i })
  }
  if (depth > 0) regions.push({ start, end: bare.length })
  return regions
}

/**
 * The citations in one Markdown block: every quote inside parentheses, and every quote in a
 * sentence led by "trace" or "traces", but no quote that follows a {@link REFERENCE}.
 */
const blockCitations = (text: string) => {
  const masked = text.replace(CODE_SPAN, blank)
  const quotes = [...masked.matchAll(QUOTE)].map(({ index, 0: match }) => ({
    text: normalize(text.slice(index + 1, index + match.length - 1))
      .replace(ELLIPSIS, '')
      .trimEnd(),
    start: index,
    end: index + match.length
  }))
  const bare = masked.replace(QUOTE, blank)
  const regions = parenRegions(bare)
  const within = (offset: number) =>
    regions.some(({ start, end }) => offset >= start && offset < end)
  for (const quote of quotes) {
    if (within(quote.start) || !TRACE_LEAD.test(text.slice(0, quote.start))) continue
    SENTENCE_END.lastIndex = quote.end
    regions.push({ start: quote.start, end: SENTENCE_END.exec(bare)?.index ?? bare.length })
  }
  return regions
    .toSorted((a, b) => a.start - b.start)
    .flatMap(({ start, end }) =>
      citationsIn(
        text,
        quotes.filter(quote => quote.start >= start && quote.start < end),
        start
      )
    )
}

type Block = Readonly<{
  line: number
  text: string
  offsets: readonly number[]
  normative: boolean
}>

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
const TABLE_ROW = /^\s*\|/
const SECTION_NUMBER = /^[\d.]+\s+/
/** A block ending in a colon introduces a list, whose items carry the evidence. */
const LEAD_IN = /:$/

const markdownBlocks = (source: string) => {
  const blocks: Block[] = []
  let current: { line: number; lines: string[]; normative: boolean } | undefined
  let fence: string | undefined
  let sectionStarted = false
  let exemptDepth: number | undefined
  const flush = () => {
    if (!current) return
    const offsets: number[] = []
    let length = 0
    for (const line of current.lines) {
      offsets.push(length)
      length += line.length + 1
    }
    const text = current.lines.join(' ')
    blocks.push({
      line: current.line,
      text,
      offsets,
      normative: current.normative && !LEAD_IN.test(text)
    })
    current = undefined
  }
  for (const [index, raw] of source.split('\n').entries()) {
    const marker = FENCE.exec(raw)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (marker) {
      flush()
      fence = marker
      continue
    }
    const heading = HEADING.exec(raw)
    if (heading) {
      flush()
      const level = heading[1]!.length
      if (level === 2) sectionStarted = true
      if (exemptDepth !== undefined && level <= exemptDepth) exemptDepth = undefined
      if (EXEMPT_SECTIONS.has(heading[2]!.replace(SECTION_NUMBER, '').trim())) exemptDepth ??= level
      continue
    }
    const normative = sectionStarted && exemptDepth === undefined
    if (raw.trim() === '') flush()
    else if (TABLE_ROW.test(raw)) {
      flush()
      current = { line: index + 1, lines: [raw], normative: false }
      flush()
    } else if (BULLET.test(raw) || !current) {
      flush()
      current = { line: index + 1, lines: [raw.trim()], normative }
    } else current.lines.push(raw.trim())
  }
  flush()
  return blocks
}

const lineOf = (block: Block, offset: number) =>
  block.line + block.offsets.findLastIndex(start => start <= offset)

/**
 * Rule 1: every citation resolves to a test title in `testSources`. Rule 2: every normative bullet
 * or paragraph holds a resolving citation or an evidence marker.
 */
export const specFindings = (spec: string, testSources: readonly string[]) => {
  const files = testSources.map(testFile)
  const unresolved: { line: number; quote: string }[] = []
  const unevidenced: { line: number }[] = []
  for (const block of markdownBlocks(spec)) {
    let evidenced = EVIDENCE_MARKERS.some(marker => block.text.includes(marker))
    for (const citation of blockCitations(block.text)) {
      if (citation.resolves(files)) evidenced = true
      else unresolved.push({ line: lineOf(block, citation.offset), quote: citation.quote })
    }
    if (block.normative && !evidenced) unevidenced.push({ line: block.line })
  }
  return { unresolved, unevidenced }
}

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && TEST_SOURCE.test(entry.name))
    .map(entry => readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))

if (import.meta.main) {
  let unresolvedCount = 0
  let unevidencedCount = 0
  const framework = path.join(REPO_ROOT, FRAMEWORK)
  const packages = existsSync(framework) ? readdirSync(framework).toSorted() : []
  for (const pkg of packages) {
    const spec = path.join(FRAMEWORK, pkg, 'SPEC.md')
    if (!existsSync(path.join(REPO_ROOT, spec))) continue
    const { unresolved, unevidenced } = specFindings(
      readFileSync(path.join(REPO_ROOT, spec), 'utf8'),
      sourcesUnder(path.join(REPO_ROOT, FRAMEWORK, pkg, 'test'))
    )
    for (const { line, quote } of unresolved)
      console.error(`${spec}:${line}  spec-citation: "${quote}" names no test title`)
    for (const { line } of unevidenced)
      console.error(`${spec}:${line}  spec-evidence: cite a test, or mark (untested) or (review)`)
    unresolvedCount += unresolved.length
    unevidencedCount += unevidenced.length
  }
  console.error(
    `\n${unresolvedCount} unresolved citation(s), ${unevidencedCount} block(s) without evidence`
  )
  if (unresolvedCount > 0 || (ENFORCE_EVIDENCE && unevidencedCount > 0)) process.exit(1)
}
