import path from 'node:path'

import { noReplayInSrc } from '../src/no-replay-in-src'
import { ruleTester } from './rule-tester'

const code = "import { replay } from '@repo/engine/replay'"

ruleTester.run('no-replay-in-src', noReplayInSrc, {
  valid: [
    { code, filename: path.join('bots', 'quoter-bot', 'test', 'scenario', 'stages.test.ts') },
    { code, filename: path.join('framework', 'kernel', 'test', 'host.test.ts') },
    { code, filename: path.join('bots', 'blue', 'scripts', 'replay-journal.ts') },
    {
      code: "import { createRunner } from '@repo/engine'",
      filename: path.join('bots', 'blue', 'src', 'run.ts')
    }
  ],
  invalid: [
    { code, filename: path.join('bots', 'blue', 'src', 'run.ts'), errors: 1 },
    { code, filename: path.join('framework', 'controller', 'src', 'tasks.ts'), errors: 1 },
    { code, filename: path.join('framework', 'tests', 'src', 'run.ts'), errors: 1 },
    {
      code: "import type { ReplayReport } from '@repo/engine/replay'",
      filename: path.join('bots', 'blue', 'src', 'journal.ts'),
      errors: 1
    }
  ]
})
