import type { Rule } from './rule.ts'

import { pathSegments } from './bot-path.ts'

const REPLAY_MODULE = '@repo/engine/replay'

/** `replay` re-runs a journal for tests and tools; a running bot or package never needs it. */
export const noReplayInSrc: Rule = {
  create: context => {
    if (!pathSegments(context.filename, context.cwd).includes('src')) return {}
    return {
      ImportDeclaration(node) {
        if (node.source.value !== REPLAY_MODULE) return
        context.report({
          node,
          message: `Import \`${REPLAY_MODULE}\` only from tests and tools, never from \`src/\``
        })
      }
    }
  }
}
