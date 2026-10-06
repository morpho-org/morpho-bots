import type { Rule } from './rule.ts'

const LINEAR_TICKET = /\b(?:BOTS|CRTR)-\d+\b/
const SECTION_BANNER = /^\s*(?:[-=*#]{3,}|#?(?:end)?region\b)/i
const STEP_NUMBER = /^\s*(?:step\s*\d+\b|\d+[.)]\s)/i

export const commentHygiene: Rule = {
  create: context => ({
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        const { loc, type, value } = comment
        if (LINEAR_TICKET.test(value)) {
          context.report({ loc, message: 'No ticket numbers in code; the PR carries provenance' })
        } else if (type === 'Line' && SECTION_BANNER.test(value)) {
          context.report({ loc, message: 'No section-header comments' })
        } else if (type === 'Line' && STEP_NUMBER.test(value)) {
          context.report({ loc, message: 'No step numbering in comments' })
        }
      }
    }
  })
}
