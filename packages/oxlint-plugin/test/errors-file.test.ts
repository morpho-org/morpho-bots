import { errorsFile } from '../src/errors-file'
import { ruleTester } from './rule-tester'

const errorClass = 'export class SetupFailedError extends Error {}'

ruleTester.run('errors-file', errorsFile, {
  valid: [
    { code: errorClass, filename: 'src/errors.ts' },
    {
      code: [
        "import type { Check } from './policy'",
        'type Reason = string',
        'interface Parameters { check: Check }',
        'class UpstreamError extends Error {}',
        'export class RpcError extends UpstreamError {}',
        'export class FeeError extends BaseError {}',
        "export type { Hex } from 'viem'"
      ].join('\n'),
      filename: 'src/errors.ts'
    },
    { code: 'export class Queue {}', filename: 'src/queue.ts' },
    { code: errorClass, filename: 'src/setup.ts' },
    { code: 'export class RpcError extends BaseError {}', filename: 'src/rpc.utils.ts' },
    { code: 'export const helper = () => 1', filename: 'src/helpers.ts' }
  ],
  invalid: [
    { code: `${errorClass}\nexport class Queue {}`, filename: 'src/errors.ts', errors: 1 },
    { code: `${errorClass}\nexport const helper = () => 1`, filename: 'src/errors.ts', errors: 1 },
    { code: `${errorClass}\nexport function helper() {}`, filename: 'src/errors.ts', errors: 1 },
    { code: "export { RpcError } from './rpc'", filename: 'src/errors.ts', errors: 1 }
  ]
})
