import path from 'node:path'

import type { Rule } from './rule.ts'

const TEST_FILE = /\.test\.tsx?$/

export const testUnderTestDir: Rule = {
  create: context => ({
    Program(node) {
      if (!TEST_FILE.test(context.filename)) return
      if (context.filename.split(path.sep).includes('test')) return
      context.report({
        node,
        message: 'Tests live under the package `test/` directory, mirroring `src/`'
      })
    }
  })
}
