import { describe, expect, it } from 'vitest'

import { specFindings } from '../src/check-spec-citations'

const testDir = [
  `
import { describe, it, test } from 'vitest'

describe('a restart', () => {
  it('does not extend an unaffirmed offer past its stale bound', () => {})
  it.each(['complete', 'carried'] as const)('keeps a %s read its own expiry', kind => {})
})

// it('a commented-out test', () => {})
test("refuses a fact registered after the seal", () => {})
const pattern = /it\\('not a title'/
function ghost() {
  return /it("a regex title")/
}
helpers.it('not a vitest call', () => {})
it.skip('a skipped test', () => {})
it.todo('a todo test')
describe.skip('a skipped block', () => {
  it('a test in a skipped block', () => {})
})
it.only('a focused test', () => {})
it.each([
  ['not hex', '0xzz'],
  ['odd length', '0x1']
])('refuses a payload that is %s', (_, data) => {})
it.each([{ name: 'a named row', raw: 'an unrendered field' }])('reads $name', row => {})
describe.skipIf(!process.env.RPC)('a conditional block', () => {})
`,
  `
import { describe, it as check } from 'vitest'

const scenarios = { 'a step that throws': {}, 'an effect that rejects': {} }
const unrelated = 'disk full'

describe.each(['Flushed', 'FlushFailed'] as const)('a %s answer', type => {
  check.each(Object.entries(scenarios))('is journaled, cause then consequence, for %s', () => {})
})

check(\`replays \${'a'} journal\`, () => {})
`,
  `
const it = (title: string, body: () => void) => body()
it('a locally defined it', () => {})
`
]

const spec = (body: string) =>
  `# Package: specification\n\nStatus: an unmarked preamble.\n\n${body}`

const unresolved = (body: string) =>
  specFindings(spec(body), testDir).unresolved.map(({ quote }) => quote)

describe('specFindings citations', () => {
  it('resolves a quote that equals or starts a title, several to a parenthesis', () => {
    expect(
      unresolved(
        '## 1. Rules\n\nRestarts hold ("a restart", "does not extend an unaffirmed offer past its\nstale bound" and "refuses a fact").'
      )
    ).toStrictEqual([])
  })

  it('reports a quote that names no title, at the line it opens on', () => {
    const { unresolved: findings } = specFindings(
      spec('## 1. Rules\n\nFirst line\n("refuses a fact", "a restart extends")'),
      testDir
    )

    expect(findings).toStrictEqual([{ line: 8, quote: 'a restart extends' }])
  })

  it('matches an each title only by its literal text before the first placeholder', () => {
    expect(
      unresolved('## 1. Rules\n\n- ("keeps a") ("keeps a complete read its own expiry") ("a")')
    ).toStrictEqual(['keeps a complete read its own expiry'])
  })

  it('stops a template title at its first substitution', () => {
    expect(unresolved('## 1. Rules\n\n("replays ") ("replays a journal")')).toStrictEqual([
      'replays a journal'
    ])
  })

  it('reads titles only from calls of it, test or describe imported from vitest, renamed or not', () => {
    expect(
      unresolved(
        '## 1. Rules\n\n("a commented-out test") ("not a title") ("a regex title") ("not a vitest call") ("a locally defined it") ("replays ")'
      )
    ).toStrictEqual([
      'a commented-out test',
      'not a title',
      'a regex title',
      'not a vitest call',
      'a locally defined it'
    ])
  })

  it('counts a focused or conditional title, never a skipped or todo one', () => {
    expect(
      unresolved(
        '## 1. Rules\n\n("a focused test") ("a conditional block") ("a skipped test") ("a todo test") ("a skipped block") ("a test in a skipped block")'
      )
    ).toStrictEqual([
      'a skipped test',
      'a todo test',
      'a skipped block',
      'a test in a skipped block'
    ])
  })

  it('resolves no empty citation', () => {
    expect(unresolved('## 1. Rules\n\n("") ("…") ("...")')).toStrictEqual(['', '', ''])
  })

  it('resolves a describe joined to a title only when the title is nested in it', () => {
    expect(
      unresolved('## 1. Rules\n\n("a restart": "does not extend") ("a restart": "refuses a fact")')
    ).toStrictEqual(['a restart: refuses a fact'])
  })

  it('resolves case names to the keys of a named table, never to other literals in its file', () => {
    expect(
      unresolved(
        [
          '## 1. Rules',
          '',
          '- ("is journaled" for each of "a step that throws", "an effect that rejects")',
          '- ("is journaled" cases: "a step that throws"; "refuses a fact")',
          '- ("is journaled" for each of "disk full")',
          '- ("keeps a" cases: "an effect that rejects")'
        ].join('\n')
      )
    ).toStrictEqual(['disk full', 'an effect that rejects'])
  })

  it('refuses a case name a scenario table of nested builders does not hold', () => {
    const runner = `
import { describe, expect, it } from 'vitest'

it('fails the graph when the sink rejects', async () => {
  await expect(append()).rejects.toThrow('disk full')
})

const scenarios: Record<string, Scenario> = {
  'a step that throws inside the recovery scope': {
    build: journal => {
      const { runner } = recoveringGraph(true, { journal })
      return { runner, trigger: () => runner.push(reads, 'boom') }
    }
  },
  'an effect that rejects': { build: journal => rejecting(journal) }
}

describe('a failure that stops or degrades the runner', () => {
  it.each(Object.entries(scenarios))(
    'is journaled, cause then consequence, for %s',
    async (_, scenario) => {}
  )
})
`
    const findings = specFindings(
      spec(
        '## 1. Rules\n\n("is journaled" for each of "a step that throws inside the recovery scope", "disk full")'
      ),
      [runner]
    )

    expect(findings.unresolved.map(({ quote }) => quote)).toStrictEqual(['disk full'])
  })

  it('resolves a case name only from a column or field its title renders', () => {
    expect(
      unresolved(
        [
          '## 1. Rules',
          '',
          '- ("refuses a payload that is %s" for each of "not hex", "odd length", "0xzz")',
          '- ("reads $name" for each of "a named row", "an unrendered field")'
        ].join('\n')
      )
    ).toStrictEqual(['0xzz', 'an unrendered field'])
  })

  it('resolves an each title quoted raw, and its case names only from its own table', () => {
    expect(
      unresolved(
        [
          '## 1. Rules',
          '',
          '- ("keeps a %s read its own expiry" for each of "complete", "carried")',
          '- ("keeps a %s read its own expiry" for each of "refuses a fact registered after the seal")',
          '- ("keeps a %s read")'
        ].join('\n')
      )
    ).toStrictEqual(['refuses a fact registered after the seal', 'keeps a %s read'])
  })

  it('reads a quote as a citation inside parentheses or in a sentence led by trace', () => {
    expect(
      unresolved(
        [
          '## 1. Rules',
          '',
          'A "literal value" is not cited. Traces: "a restart", and the matrix "no such trace".',
          'The trace "unknown title" checks this. Then "another literal".'
        ].join('\n')
      )
    ).toStrictEqual(['no such trace', 'unknown title'])
  })

  it('skips a quote that follows a section or decision reference, and a trailing ellipsis', () => {
    expect(
      unresolved(
        '## 1. Rules\n\nCapped (§6, "Fees") per (ADR-2026-09-30, "A key") ("does not extend an…")'
      )
    ).toStrictEqual([])
  })

  it('ignores quotes in code spans and fences', () => {
    expect(
      unresolved('## 1. Rules\n\nRun `("nothing")` (untested).\n\n```\n("nothing")\n```')
    ).toStrictEqual([])
  })
})

describe('specFindings evidence', () => {
  it('flags each normative bullet and paragraph without a resolving citation or marker', () => {
    const body = [
      '## 1. Rules',
      '',
      'An unmarked paragraph',
      'spanning two lines.',
      '',
      'The list:',
      '',
      '- A cited bullet ("a restart").',
      '- An unmarked bullet',
      '  continued here.',
      '  - A nested unmarked bullet.',
      '- A bullet citing only a missing test ("missing").',
      '- An untested bullet (untested).',
      '- A reviewed bullet (review).',
      '',
      '| table | row |',
      '| ----- | --- |',
      '',
      '### 1.1 Sub',
      '',
      'Another unmarked paragraph.'
    ].join('\n')

    expect(specFindings(spec(body), testDir).unevidenced).toStrictEqual([
      { line: 7 },
      { line: 13 },
      { line: 15 },
      { line: 16 },
      { line: 25 }
    ])
  })

  it('exempts the preamble and the sections left out, risks and traces, with their subsections', () => {
    const body = [
      '## 13. What is deliberately left out',
      '',
      '- Unmarked.',
      '',
      '### 13.1 More',
      '',
      'Unmarked.',
      '',
      '## 14. Residual risks',
      '',
      'Unmarked.',
      '',
      '## 15. Traces',
      '',
      'Unmarked.',
      '',
      '## 16. Rules',
      '',
      'Unmarked.'
    ].join('\n')

    expect(specFindings(spec(body), testDir).unevidenced).toStrictEqual([{ line: 23 }])
  })
})
