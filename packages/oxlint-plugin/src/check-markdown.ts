import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { copyIssues } from './copy-style.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const VENDORED = 'docs/context/'
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LINK_TARGET = /\]\([^)]*\)/g
const HEADING = /^#{1,6}\s+(.*)$/
const TITLE_CASE_WORD = /^[A-Z][a-z]+(?:-[A-Za-z]+)*$/
const CLAUSE_START = /[:—]$/
const NUMBERING = /^\d+[a-z]?(?:\.\d+)*[.):]?$/
const PROPER_NOUNS = new Set([
  ...['Market', 'Vault', 'Curator', 'Allocator', 'Sentinel', 'Guardian', 'Owner', 'Gate'].flatMap(
    term => [term, `${term}s`]
  ),
  'Morpho',
  'Blue',
  'Midnight',
  'Executor',
  'Linear',
  'Railway',
  'Codex',
  'Claude',
  'Devin',
  'Docker',
  'Compose',
  'Helm',
  'Node',
  'Better',
  'Stack',
  'Notion',
  'Sentry',
  'Slack',
  'Foundry',
  'Anvil',
  'Base',
  'Ethereum',
  'Robinhood',
  'Uniswap',
  'Pendle',
  'Kubernetes'
])

/** Sentence case: after the first word, only proper nouns, acronyms, and clause starts are capitalized. */
const headingIssues = (line: string) => {
  const text = HEADING.exec(line)?.[1]
  if (text === undefined) return []
  const tokens = text
    .replace(/`[^`]*`|\]\([^)]*\)|[[\]]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const words = tokens.slice(tokens.findIndex(token => !NUMBERING.test(token)))
  return words
    .slice(1)
    .filter((word, index) => {
      const bare = word.replace(/^[("']+|[)"',.;:?!]+$/g, '')
      return (
        TITLE_CASE_WORD.test(bare) &&
        !PROPER_NOUNS.has(bare) &&
        !CLAUSE_START.test(words[index] ?? '')
      )
    })
    .map(word => `heading-sentence-case: lowercase "${word.replace(/[^\w-]/g, '')}"`)
}

export const markdownFindings = (source: string) => {
  const findings: { line: number; message: string }[] = []
  let fence: string | undefined
  for (const [index, line] of source.split('\n').entries()) {
    const [, marker, rest] = FENCE.exec(line) ?? []
    if (fence) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && !rest?.trim()) fence = undefined
    } else if (marker) {
      fence = marker
    } else {
      for (const message of [
        ...copyIssues(line.replace(LINK_TARGET, ']')),
        ...headingIssues(line)
      ]) {
        findings.push({ line: index + 1, message })
      }
    }
  }
  return findings
}

const trackedMarkdown = () =>
  execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '' && !file.startsWith(VENDORED))

if (import.meta.main) {
  const argv = process.argv.slice(2).map(file => path.relative(REPO_ROOT, path.resolve(file)))
  const files = (argv.length > 0 ? argv : trackedMarkdown()).filter(f => !f.startsWith(VENDORED))
  let count = 0
  for (const file of files) {
    for (const { line, message } of markdownFindings(
      readFileSync(path.join(REPO_ROOT, file), 'utf8')
    )) {
      console.error(`${file}:${line}  ${message}`)
      count++
    }
  }
  if (count > 0) {
    console.error(`\n${count} copy-style finding(s)`)
    process.exit(1)
  }
}
