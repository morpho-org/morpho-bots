import path from 'node:path'

import type { Rule } from './rule.ts'

const ERRORS_FILE = 'errors.ts'
const DECLARATIONS = new Set([
  'ImportDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration'
])

export const extendsError = (superClass: unknown) =>
  typeof superClass === 'object' &&
  superClass !== null &&
  'type' in superClass &&
  superClass.type === 'Identifier' &&
  'name' in superClass &&
  typeof superClass.name === 'string' &&
  superClass.name.endsWith('Error')

const isErrorDeclaration = (statement: { type: string; superClass?: unknown }) =>
  DECLARATIONS.has(statement.type) ||
  (statement.type === 'ClassDeclaration' && extendsError(statement.superClass))

/** An `errors.ts` declares nothing but error classes and their types. */
export const errorsFile: Rule = {
  create: context => {
    if (path.basename(context.filename) !== ERRORS_FILE) return {}
    return {
      Program(program) {
        for (const statement of program.body) {
          const declaration =
            statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
          if (declaration && isErrorDeclaration(declaration)) continue
          if (statement.type === 'ExportNamedDeclaration' && statement.exportKind === 'type')
            continue
          context.report({
            node: statement,
            message: `An \`${ERRORS_FILE}\` declares only error classes and their types`
          })
        }
      }
    }
  }
}
