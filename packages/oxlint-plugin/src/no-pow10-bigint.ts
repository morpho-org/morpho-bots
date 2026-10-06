import type { Rule } from './rule.ts'

export const noPow10Bigint: Rule = {
  create: context => ({
    BinaryExpression(node) {
      const { left, right } = node
      if (node.operator !== '**') return
      if (left.type !== 'Literal' || !('bigint' in left) || left.bigint !== '10') return
      if (right.type !== 'CallExpression' || right.callee.type !== 'Identifier') return
      if (right.callee.name !== 'BigInt') return
      context.report({ node, message: 'Use viem `parseUnits` / `formatUnits` for decimal scaling' })
    }
  })
}
