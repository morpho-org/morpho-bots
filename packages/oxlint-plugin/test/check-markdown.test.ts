import { describe, expect, it } from 'vitest'

import { markdownFindings } from '../src/check-markdown'

describe('markdownFindings', () => {
  it('flags prose and skips code spans, fences, and link targets', () => {
    const source = [
      'Offchain bots read on-chain state.',
      'Run `on-chain` checks; see [the guide](https://example.com/on-chain).',
      '```sh',
      'echo off-chain',
      '```',
      'One Midnight market per maturity.'
    ].join('\n')

    expect(markdownFindings(source)).toStrictEqual([
      { line: 1, message: 'spell-onchain: use onchain' },
      {
        line: 6,
        message:
          'case-morpho-term: use the capitalized term: Market, Vault, Curator, Allocator, Sentinel, Guardian, Owner, Gate'
      }
    ])
  })

  it('closes a fence only on the same marker, at least as long, with no info string', () => {
    const source = [
      '````md',
      '```sh',
      'echo off-chain',
      '```',
      'on-chain inside the outer fence',
      '````',
      '~~~',
      '```',
      'off-chain',
      '~~~',
      'Offchain bots read on-chain state.'
    ].join('\n')

    expect(markdownFindings(source)).toStrictEqual([
      { line: 11, message: 'spell-onchain: use onchain' }
    ])
  })

  it('holds headings to sentence case, allowing proper nouns, numbering, and clause starts', () => {
    const source = [
      '# Blue Liquidation Bot',
      '## Running with Docker Compose on Base',
      '### 1. Assess the Vault',
      '### Step 2: Draft a plan',
      '## ADR-2026-05-28: The Executor is generic'
    ].join('\n')

    expect(markdownFindings(source)).toStrictEqual([
      { line: 1, message: 'heading-sentence-case: lowercase "Liquidation"' },
      { line: 1, message: 'heading-sentence-case: lowercase "Bot"' }
    ])
  })
})
