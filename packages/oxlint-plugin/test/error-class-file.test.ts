import { errorClassFile } from '../src/error-class-file'
import { ruleTester } from './rule-tester'

const errorClass = 'export class SetupFailedError extends Error {}'

ruleTester.run('error-class-file', errorClassFile, {
  valid: [
    { code: errorClass, filename: 'src/setup-failed.error.ts' },
    {
      code: 'export class JSDocValidationError extends Error {}',
      filename: 'js-doc-validation.error.ts'
    },
    { code: 'export class Queue {}', filename: 'src/queue.service.ts' }
  ],
  invalid: [
    { code: errorClass, filename: 'src/setup.service.ts', errors: 1 },
    { code: 'export class RpcError extends BaseError {}', filename: 'src/rpc.utils.ts', errors: 1 },
    { code: errorClass, filename: 'src/setup.error.ts', errors: 1 },
    {
      code: `${errorClass}\nexport class OtherError extends Error {}`,
      filename: 'src/setup-failed.error.ts',
      errors: 1
    }
  ]
})
