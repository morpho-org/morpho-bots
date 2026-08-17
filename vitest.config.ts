import { defineConfig } from 'vitest/config'

// Workspace runner: every member that carries tests is a project. The two liquidation bots hold
// their own vitest.config.ts (soltag `sol``` transform + fork-suite env files); the rest run with
// defaults rooted at their own directory.
export default defineConfig({
  test: {
    projects: [
      // Workspace-wide invariants that belong to no single member (dependency deduplication).
      { test: { name: 'workspace', root: import.meta.dirname, include: ['test/**/*.test.ts'] } },
      'packages/utils',
      'packages/bot-kit',
      'packages/swaps',
      'packages/logging',
      'packages/monitoring',
      'packages/observability',
      'packages/offers',
      'bots/blue-liquidation',
      'bots/blue-reallocation',
      'bots/midnight-liquidation',
      'bots/midnight-crossed-books',
      'bots/quoter-bot'
    ]
  }
})
