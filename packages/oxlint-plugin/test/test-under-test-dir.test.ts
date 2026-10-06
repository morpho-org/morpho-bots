import path from 'node:path'

import { testUnderTestDir } from '../src/test-under-test-dir'
import { ruleTester } from './rule-tester'

const code = "it('works', () => {})"

ruleTester.run('test-under-test-dir', testUnderTestDir, {
  valid: [
    { code, filename: path.join('bots', 'blue', 'test', 'tick.test.ts') },
    { code, filename: path.join('bots', 'blue', 'src', 'tick.ts') }
  ],
  invalid: [
    { code, filename: path.join('bots', 'quoter-bot', 'scripts', 'check-jsdoc.test.ts'), errors: 1 }
  ]
})
