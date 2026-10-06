import type { Rule } from './rule.ts'

export const noHexTemplate: Rule = {
  create: context => ({
    TSTemplateLiteralType(node) {
      if (node.quasis[0]?.value.raw !== '0x') return
      context.report({
        node,
        message: 'Use `Address` or `Hex` from viem, not an inline `0x${string}`'
      })
    }
  })
}
