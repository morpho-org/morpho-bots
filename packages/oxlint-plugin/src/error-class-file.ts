import path from 'node:path'

import type { Rule } from './rule.ts'

const ERROR_FILE_SUFFIX = '.error.ts'

const extendsError = (superClass: unknown) =>
  typeof superClass === 'object' &&
  superClass !== null &&
  'type' in superClass &&
  superClass.type === 'Identifier' &&
  'name' in superClass &&
  typeof superClass.name === 'string' &&
  superClass.name.endsWith('Error')

const fileStem = (filename: string) =>
  path.basename(filename, ERROR_FILE_SUFFIX).replaceAll('-', '')

export const errorClassFile: Rule = {
  create: context => {
    const isErrorFile = context.filename.endsWith(ERROR_FILE_SUFFIX)
    let classCount = 0
    return {
      ClassDeclaration(node) {
        classCount++
        if (!isErrorFile) {
          if (extendsError(node.superClass)) {
            context.report({
              node,
              message: 'Define each error class in its own kebab-case `*.error.ts` file'
            })
          }
          return
        }
        if (classCount > 1) {
          context.report({ node, message: 'A `*.error.ts` file holds exactly one class' })
          return
        }
        const name = node.id?.name ?? ''
        if (fileStem(context.filename) !== name.replace(/Error$/, '').toLowerCase()) {
          context.report({ node, message: `Name the file for the class: \`${name}\`` })
        }
      }
    }
  }
}
