import { commentHygiene } from '../src/comment-hygiene'
import { ruleTester } from './rule-tester'

ruleTester.run('comment-hygiene', commentHygiene, {
  valid: [
    '// Rounds down per EIP-712 and ERC-4626 (see UTF-8 note)\nconst a = 1',
    '// 30 bps margin, 1.5x headroom\nconst a = 1',
    '/** Returns the price. */\nconst a = 1'
  ],
  invalid: [
    { code: '// Fixes BOTS-90\nconst a = 1', errors: 1 },
    { code: '/** Since CRTR-2804 this is exact. */\nconst a = 1', errors: 1 },
    { code: '// ---------------------\nconst a = 1', errors: 1 },
    { code: '// --- Wallet A ---\nconst a = 1', errors: 1 },
    { code: '// #region setup\nconst a = 1', errors: 1 },
    { code: '// 1. Discover positions\nconst a = 1', errors: 1 },
    { code: '// Step 2: simulate\nconst a = 1', errors: 1 }
  ]
})
