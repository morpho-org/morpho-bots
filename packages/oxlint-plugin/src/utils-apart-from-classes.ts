import type { Rule } from './rule.ts'

const MESSAGE = 'Move utility functions out of a class file, into `*.utils.ts` or a module'

export const utilsApartFromClasses: Rule = {
  create: context => {
    let hasClass = false
    const reports: (() => void)[] = []
    return {
      ClassDeclaration() {
        hasClass = true
      },
      ExportNamedDeclaration(node) {
        const { declaration } = node
        const isFunction =
          declaration?.type === 'FunctionDeclaration' ||
          (declaration?.type === 'VariableDeclaration' &&
            declaration.declarations.some(
              ({ init }) =>
                init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'
            ))
        if (isFunction) reports.push(() => context.report({ node, message: MESSAGE }))
      },
      'Program:exit'() {
        if (hasClass) for (const report of reports) report()
      }
    }
  }
}
