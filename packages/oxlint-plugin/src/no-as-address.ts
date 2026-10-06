import type { Rule } from './rule.ts'

export const noAsAddress: Rule = {
  create: context => ({
    TSAsExpression(node) {
      const type = node.typeAnnotation
      if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return
      if (type.typeName.name !== 'Address') return
      context.report({
        node,
        message:
          'Narrow with `isAddress()` (then `getAddress()` to checksum) instead of `as Address`'
      })
    }
  })
}
