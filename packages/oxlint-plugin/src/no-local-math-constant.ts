import type { Rule } from './rule.ts'

type Node = { type: string; operator?: string; left?: Node; right?: Node; bigint?: string }

const SCALE_BY_EXPONENT: Record<string, string> = { '18': 'MathLib.WAD', '27': 'MathLib.RAY' }

const isBigint = (node: Node | undefined, value?: string) =>
  node?.type === 'Literal' && typeof node.bigint === 'string' && (!value || node.bigint === value)

const powerOf = (node: Node | undefined, base: string) =>
  node?.type === 'BinaryExpression' &&
  node.operator === '**' &&
  isBigint(node.left, base) &&
  isBigint(node.right)
    ? node.right?.bigint
    : undefined

export const noLocalMathConstant: Rule = {
  create: context => ({
    BinaryExpression(node) {
      const exponent = powerOf(node as Node, '10')
      if (exponent !== undefined && exponent in SCALE_BY_EXPONENT) {
        context.report({ node, message: `Use \`${SCALE_BY_EXPONENT[exponent]}\`` })
        return
      }
      const bits = node.operator === '-' ? powerOf(node.left as Node, '2') : undefined
      const supported = bits !== undefined && Number(bits) > 0 && Number(bits) % 4 === 0
      if (supported && isBigint(node.right as Node, '1')) {
        context.report({ node, message: `Use \`MathLib.maxUint(${bits})\`` })
      }
    }
  })
}
