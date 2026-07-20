import { defineConfig } from 'vitest/config'

// Workspace runner: each member with tests is a project. The bots carry their own
// vitest.config.ts (soltag `sol``` transform + fork-suite env files); the packages run with
// defaults rooted at their directory.
export default defineConfig({
  test: {
    projects: [
      'packages/utils',
      'packages/bot-kit',
      'packages/swaps',
      'bots/blue-liquidation',
      'bots/midnight-liquidation'
    ]
  }
})
