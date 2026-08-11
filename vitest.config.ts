import { defineConfig } from 'vitest/config'

// Workspace runner: every member that carries tests is a project. The two liquidation bots hold
// their own vitest.config.ts (soltag `sol``` transform + fork-suite env files); the rest run with
// defaults rooted at their own directory.
export default defineConfig({
  test: {
    projects: [
      'packages/utils',
      'packages/bot-kit',
      'packages/swaps',
      'packages/logging',
      'packages/monitoring',
      'packages/observability',
      'packages/offers',
      'bots/blue-liquidation',
      'bots/midnight-liquidation',
      'bots/midnight-crossed-books',
      'bots/market-making'
    ]
  }
})
