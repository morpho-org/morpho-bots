#!/usr/bin/env node

/**
 * retro-pr-stats.mjs
 *
 * Calculate LOC metrics across a set of GitHub PRs for retrospective documents.
 *
 * Usage:
 *   node .claude/scripts/retro-pr-stats.mjs <pr_numbers...>
 *   node .claude/scripts/retro-pr-stats.mjs 844 1013 1020 1070
 *
 * Requires: `gh` CLI authenticated with access to morpho-org/morpho-bots
 *
 * Output: JSON summary and markdown table with per-PR and aggregate stats.
 */

import { execFileSync } from 'node:child_process'

const REPO = process.env.GITHUB_REPO || 'morpho-org/morpho-bots'

function usage() {
  console.error(`
Usage: node retro-pr-stats.mjs <pr_numbers...>

  Compute LOC metrics for a set of GitHub PRs.

Examples:
  node retro-pr-stats.mjs 844 1013 1020 1070
  GITHUB_REPO=morpho-org/other-repo node retro-pr-stats.mjs 1 2 3

Environment:
  GITHUB_REPO  Repository in owner/repo format (default: morpho-org/morpho-bots)
`)
  process.exit(1)
}

function fetchPRStats(prNumber) {
  try {
    const raw = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        REPO,
        '--json',
        'number,title,additions,deletions,changedFiles,mergedAt,url'
      ],
      { encoding: 'utf-8', timeout: 30_000 }
    )
    return JSON.parse(raw)
  } catch (error) {
    console.error(`Warning: Failed to fetch PR #${prNumber}: ${error.message}`)
    return null
  }
}

function formatNumber(n) {
  return n.toLocaleString('en-US')
}

function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'))

  if (args.length === 0) {
    usage()
  }

  const prNumbers = args.map(a => {
    const n = parseInt(a, 10)
    if (isNaN(n)) {
      console.error(`Error: "${a}" is not a valid PR number`)
      process.exit(1)
    }
    return n
  })

  console.error(`Fetching stats for ${prNumbers.length} PRs from ${REPO}...\n`)

  const results = []

  for (const pr of prNumbers) {
    const stats = fetchPRStats(pr)
    if (stats) {
      results.push({
        number: stats.number,
        title: stats.title,
        additions: stats.additions,
        deletions: stats.deletions,
        changedFiles: stats.changedFiles,
        netChange: stats.additions - stats.deletions,
        totalChange: stats.additions + stats.deletions,
        mergedAt: stats.mergedAt,
        url: stats.url
      })
    }
  }

  if (results.length === 0) {
    console.error('Error: No PR data retrieved. Check your gh auth and PR numbers.')
    process.exit(1)
  }

  // Aggregate stats
  const totals = results.reduce(
    (acc, r) => ({
      additions: acc.additions + r.additions,
      deletions: acc.deletions + r.deletions,
      changedFiles: acc.changedFiles + r.changedFiles,
      netChange: acc.netChange + r.netChange,
      totalChange: acc.totalChange + r.totalChange
    }),
    { additions: 0, deletions: 0, changedFiles: 0, netChange: 0, totalChange: 0 }
  )

  const avgAdditions = Math.round(totals.additions / results.length)
  const avgDeletions = Math.round(totals.deletions / results.length)
  const avgTotalChange = Math.round(totals.totalChange / results.length)

  const largest = results.reduce((max, r) => (r.totalChange > max.totalChange ? r : max))
  const smallest = results.reduce((min, r) => (r.totalChange < min.totalChange ? r : min))

  // Warn about unmerged PRs (likely accidental input)
  const unmerged = results.filter(r => !r.mergedAt)
  if (unmerged.length > 0) {
    console.error(
      `Warning: ${unmerged.length} PR(s) not yet merged: ${unmerged.map(r => `#${r.number}`).join(', ')}. These will appear at the end of the timeline.`
    )
  }

  // Sort by merge date — unmerged PRs sort to the end
  const sorted = [...results].sort((a, b) => {
    if (!a.mergedAt && !b.mergedAt) return a.number - b.number
    if (!a.mergedAt) return 1
    if (!b.mergedAt) return -1
    return new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime()
  })

  // Output JSON summary to stderr for programmatic use
  const summary = {
    repo: REPO,
    prCount: results.length,
    totals,
    averages: {
      additions: avgAdditions,
      deletions: avgDeletions,
      totalChange: avgTotalChange
    },
    largest: { number: largest.number, totalChange: largest.totalChange },
    smallest: { number: smallest.number, totalChange: smallest.totalChange }
  }
  console.error('JSON Summary:')
  console.error(JSON.stringify(summary, null, 2))
  console.error('')

  // Output markdown table to stdout
  console.log('## PR Statistics\n')
  console.log('### Aggregate\n')
  console.log('| Metric              | Value        |')
  console.log('| ------------------- | ------------ |')
  console.log(`| PRs analyzed        | ${results.length}            |`)
  console.log(`| Total files changed | ${formatNumber(totals.changedFiles)}          |`)
  console.log(`| Total insertions    | +${formatNumber(totals.additions)}         |`)
  console.log(`| Total deletions     | -${formatNumber(totals.deletions)}         |`)
  console.log(
    `| Net change          | ${totals.netChange >= 0 ? '+' : ''}${formatNumber(totals.netChange)} lines |`
  )
  console.log(
    `| Average PR size     | +${formatNumber(avgAdditions)} / -${formatNumber(avgDeletions)} (${formatNumber(avgTotalChange)} total) |`
  )
  console.log(
    `| Largest PR          | [#${largest.number}] (+${formatNumber(largest.additions)} / -${formatNumber(largest.deletions)}) |`
  )
  console.log(
    `| Smallest PR         | [#${smallest.number}] (+${formatNumber(smallest.additions)} / -${formatNumber(smallest.deletions)}) |`
  )

  console.log('\n### Per-PR Breakdown\n')
  console.log('| PR | Title | Additions | Deletions | Net | Files |')
  console.log('| -- | ----- | --------: | --------: | --: | ----: |')
  for (const r of sorted) {
    const shortTitle = (r.title.length > 60 ? r.title.slice(0, 57) + '...' : r.title).replaceAll(
      '|',
      '\\|'
    )
    console.log(
      `| [#${r.number}] | ${shortTitle} | +${formatNumber(r.additions)} | -${formatNumber(r.deletions)} | ${r.netChange >= 0 ? '+' : ''}${formatNumber(r.netChange)} | ${r.changedFiles} |`
    )
  }

  console.log('\n---\n')
  console.log(
    `_Generated by retro-pr-stats.mjs on ${new Date().toISOString().slice(0, 10)} from ${REPO}_`
  )
}

main()
