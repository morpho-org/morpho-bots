import { getAddress, isAddress } from 'viem'

import type { Rule } from './rule.ts'

const misCased = (value: string) =>
  isAddress(value, { strict: false }) && getAddress(value) !== value ? getAddress(value) : undefined

export const requireChecksumAddress: Rule = {
  create: context => ({
    Literal(node) {
      const checksummed = typeof node.value === 'string' ? misCased(node.value) : undefined
      if (checksummed)
        context.report({ node, message: `Write the address checksummed: ${checksummed}` })
    },
    TemplateLiteral(node) {
      const [quasi] = node.quasis
      const text = node.expressions.length === 0 && quasi ? quasi.value.cooked : undefined
      const checksummed = text ? misCased(text) : undefined
      if (checksummed)
        context.report({ node, message: `Write the address checksummed: ${checksummed}` })
    }
  })
}
