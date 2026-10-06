import { noLocalMathConstant } from '../src/no-local-math-constant'
import { ruleTester } from './rule-tester'

ruleTester.run('no-local-math-constant', noLocalMathConstant, {
  valid: [
    'const x = 10n ** 6n',
    'const x = 10n ** BigInt(decimals)',
    'const modulus = 2n ** 256n',
    'const x = 2n ** 128n - 2n',
    'const one = 2n ** 1n - 1n'
  ],
  invalid: [
    { code: 'const WAD = 10n ** 18n', errors: [{ message: 'Use `MathLib.WAD`' }] },
    { code: 'const RAY = 10n ** 27n', errors: [{ message: 'Use `MathLib.RAY`' }] },
    { code: 'const max = 2n ** 128n - 1n', errors: [{ message: 'Use `MathLib.maxUint(128)`' }] }
  ]
})
