import { noPow10Bigint } from '../src/no-pow10-bigint'
import { ruleTester } from './rule-tester'

ruleTester.run('no-pow10-bigint', noPow10Bigint, {
  valid: ['const x = 10n ** 18n', 'const x = 2n ** BigInt(bits)', 'const x = 10 ** decimals'],
  invalid: [{ code: 'const scale = 10n ** BigInt(decimals)', errors: 1 }]
})
